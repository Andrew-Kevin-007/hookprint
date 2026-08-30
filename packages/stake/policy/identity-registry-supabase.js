/**
 * policy/identity-registry-supabase.js — the durable, cross-process twin of
 * `identity-registry.js`.
 *
 * WHAT THIS IS, STATED PLAINLY: `identity-registry.js`'s own header names the
 * gap this closes verbatim — "a real deployment would need a durable,
 * queryable... binding, not a plain object living in one Node process's
 * heap." This module is that durable binding: the SAME three-method shape
 * (`register`, `lookup`, `has`) over the `identity_registry` table in
 * Supabase (see `supabase/migrations/202608301003_identity_registry.sql`)
 * instead of an in-memory `Map`. Every method here returns a Promise —
 * `identity-registry.js` stays exactly as it is; nothing about this file
 * changes that one's behavior or callers.
 *
 * WHY THE METHOD NAMES AND SEMANTICS MATCH `identity-registry.js` EXACTLY:
 * `slash-policy.js`'s `evaluateQualityFailure` / `evaluateContradiction` (and
 * everything that calls them) were made `async` and `await` every
 * `registry.lookup(...)` call specifically so either registry — this one or
 * the in-memory one — can be handed in interchangeably. `await`ing a plain
 * synchronous value (what the Map-backed registry returns) resolves
 * immediately, so that refactor changes nothing about the Map-backed path;
 * this module is what makes the `await` load-bearing.
 *
 * FAIL-CLOSED CONVENTION, same as `identity-registry.js`'s own header:
 * `lookup()` resolves to `null` for an unregistered `keyId` — never rejects
 * for "I don't know this keyId," since that is an expected, normal outcome.
 * `has()` never rejects either. `register()` DOES reject/throw on a
 * malformed call (bad keyId, bad address shape) — validated CLIENT-SIDE,
 * before any network round-trip, with the exact same regex
 * `identity-registry.js` uses, so a caller gets the identical validation
 * contract regardless of which registry it was handed.
 *
 * SCOPE: no RLS policies are relied on here — see
 * `supabase/migrations/README.md` for why. `serviceRoleKey` is a server-side
 * secret (bypasses RLS by Supabase's own design); this module must never be
 * given to client-side/browser code.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

/** Same shape check `identity-registry.js` uses — kept identical on purpose. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const TABLE = 'identity_registry';

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createSupabaseIdentityRegistry: ${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

/**
 * createSupabaseIdentityRegistry({ supabaseUrl, serviceRoleKey })
 * -> { register(keyId, evmAddress, registeredBy?), lookup(keyId), has(keyId) }
 *
 * All three methods return Promises. `supabaseUrl`/`serviceRoleKey` are
 * validated up front — a caller passing an incomplete config gets a clear
 * error immediately, not a confusing failure on the first query.
 */
function createSupabaseIdentityRegistry({ supabaseUrl, serviceRoleKey } = {}) {
  assertNonEmptyString(supabaseUrl, 'supabaseUrl');
  assertNonEmptyString(serviceRoleKey, 'serviceRoleKey');

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return {
    /**
     * Bind `keyId` to `evmAddress`, upserting on `key_id` — re-registering
     * the same keyId overwrites the prior binding (last write wins), same
     * convention as `identity-registry.js`'s `register()`. `registeredBy`
     * is optional (an EVM address, per the `profiles` FK the migration
     * defines) and stored as-is; omit it to leave it null.
     */
    async register(keyId, evmAddress, registeredBy) {
      assertNonEmptyString(keyId, 'keyId');
      assertNonEmptyString(evmAddress, 'evmAddress');
      if (!EVM_ADDRESS_RE.test(evmAddress)) {
        throw new Error(`createSupabaseIdentityRegistry: evmAddress "${evmAddress}" is not a well-formed EVM address (0x + 40 hex chars)`);
      }

      const row = {
        key_id: keyId,
        evm_address: evmAddress,
        registered_by: registeredBy ?? null,
        updated_at: new Date().toISOString()
      };
      const { error } = await client.from(TABLE).upsert(row, { onConflict: 'key_id' });
      if (error) {
        throw new Error(`createSupabaseIdentityRegistry.register: Supabase upsert failed for keyId "${keyId}": ${error.message}`);
      }
    },

    /** The EVM address bound to `keyId`, or `null` if never registered. Never throws for "not found." */
    async lookup(keyId) {
      if (typeof keyId !== 'string' || keyId.length === 0) return null;

      const { data, error } = await client.from(TABLE).select('evm_address').eq('key_id', keyId).maybeSingle();
      if (error) {
        throw new Error(`createSupabaseIdentityRegistry.lookup: Supabase select failed for keyId "${keyId}": ${error.message}`);
      }
      return data ? data.evm_address : null;
    },

    /** Whether `keyId` has a binding. Never throws for "not found." */
    async has(keyId) {
      if (typeof keyId !== 'string' || keyId.length === 0) return false;

      const { count, error } = await client.from(TABLE).select('key_id', { count: 'exact', head: true }).eq('key_id', keyId);
      if (error) {
        throw new Error(`createSupabaseIdentityRegistry.has: Supabase select failed for keyId "${keyId}": ${error.message}`);
      }
      return Boolean(count);
    }
  };
}

module.exports = { createSupabaseIdentityRegistry };
