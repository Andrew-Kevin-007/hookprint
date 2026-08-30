/**
 * QUORUM dispatch — ledger/supabase-store.js
 *
 * The durable, cross-process, cross-machine twin of ledger/store.js's local
 * JSONL file — the same relationship packages/stake/policy/identity-
 * registry-supabase.js already has to identity-registry.js's in-memory Map
 * (see that file's own header). This is NOT a replacement for the local
 * ledger: store.js's `appendEvent()`/`readEvents()`/`computePoolState()` keep
 * working exactly as before, with zero Supabase credentials, in every
 * existing test and every existing caller (bench/degradation/campaign.js's
 * resumable runner, dispatcher/policy.js's `logRouteDecision()`,
 * merge/index.js's `mergeRoute()`). This module is an ADDITIONAL, OPTIONAL
 * mirror a caller wires in on top, one event at a time — there is no
 * dependency in the other direction, and nothing here is imported by
 * store.js, reputation.js, curves.js, or merge/index.js.
 *
 * SCHEMA: mirrors execution-contracts.js's `createLedgerEvent()` shape
 * (eventType/taskId/provider/routeId/payload/timestamp) as real columns, not
 * a JSONB dump of the whole event — see
 * kevin_frontend/supabase/migrations/*_dispatch_ledger_events.sql for the
 * table this writes to and why eventType/taskId/provider/timestamp are real
 * indexed columns rather than buried inside payload: ledger/store.js's own
 * `readEvents()` filters on exactly these three (since/eventType/taskId), so
 * giving them real columns lets a real query replicate that same filter
 * server-side instead of a full-table scan over payload.
 *
 * FAIL-CLOSED / GRACEFUL-DEGRADATION CONTRACT, same as identity-registry-
 * supabase.js: `maybeCreateSupabaseLedgerStore()` returns `null` (never
 * throws) when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are not both set —
 * this is what lets bin/quorum.js's `cmdRun()` call it unconditionally and
 * skip cleanly with a clear log line, exactly like `cmdCampaign()` skips a
 * provider with no API key. `createSupabaseLedgerStore()` itself validates
 * its two required options eagerly and throws on a malformed call — same
 * split identity-registry-supabase.js uses (a bad call is a real bug to
 * surface loudly; absent credentials is an expected, normal deployment
 * state, not a bug).
 *
 * `appendEvent()` here is deliberately NAMED to match ledger/store.js's own
 * `appendEvent(ledgerPath, event)` — same verb, so a caller mirroring one
 * event to both stores reads as "append it here too," not as a different
 * operation. The Supabase version drops the `ledgerPath` argument (there is
 * one shared table, not many files) and returns a Promise; every other real
 * behavior (accepts any object shaped like `createLedgerEvent()`'s output,
 * does not require that exact shape) matches.
 *
 * WRITE FAILURE IS LOUD, ON PURPOSE — asymmetric with the read-side "no
 * ledger yet is not a failure" convention elsewhere in this codebase: a
 * WRITE that silently failed would make the local ledger and the Supabase
 * mirror silently diverge, which is worse than a caller having to catch and
 * log a rejected promise. `bin/quorum.js`'s `cmdRun()` does exactly that —
 * catches per-event, logs, and keeps going, so one flaky mirror write never
 * aborts a real local-ledger run.
 */

import { createClient } from '@supabase/supabase-js';

const TABLE = 'dispatch_ledger_events';

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`createSupabaseLedgerStore: ${label} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
}

/**
 * createSupabaseLedgerStore({ supabaseUrl, serviceRoleKey }) -> { appendEvent(event) }
 *
 * `appendEvent()` returns a Promise resolving to the same event (matching
 * ledger/store.js's `appendEvent()` return-for-chaining convention) and
 * rejects on a real write failure — see file header "WRITE FAILURE IS LOUD".
 */
export function createSupabaseLedgerStore({ supabaseUrl, serviceRoleKey } = {}) {
  assertNonEmptyString(supabaseUrl, 'supabaseUrl');
  assertNonEmptyString(serviceRoleKey, 'serviceRoleKey');

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  return {
    async appendEvent(event) {
      if (!event || typeof event !== 'object') {
        throw new Error('createSupabaseLedgerStore.appendEvent: event must be an object');
      }

      const row = {
        event_type: event.eventType ?? null,
        task_id: event.taskId ?? null,
        provider: event.provider ?? null,
        route_id: event.routeId ?? null,
        payload: event.payload ?? {},
        event_timestamp: event.timestamp ?? new Date().toISOString()
      };

      const { error } = await client.from(TABLE).insert(row);
      if (error) {
        throw new Error(`createSupabaseLedgerStore.appendEvent: Supabase insert failed for eventType "${event.eventType}": ${error.message}`);
      }
      return event;
    }
  };
}

/**
 * Best-effort factory: reads SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY from
 * `env` (defaults to `process.env`) and returns a real store, or `null` with
 * a clear log line when either is missing — never throws for "not
 * configured," matching `bin/quorum.js`'s `cmdCampaign()` "no credentials
 * found" pattern for provider keys. `logger` defaults to `console.log`; a
 * caller that wants silence (e.g. a test) can pass a no-op.
 *
 * @param {{ env?: NodeJS.ProcessEnv, logger?: (msg: string) => void }} [opts]
 * @returns {{ appendEvent(event: object): Promise<object> } | null}
 */
export function maybeCreateSupabaseLedgerStore({ env = process.env, logger = console.log } = {}) {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    logger('[ledger] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set -- Supabase ledger mirror disabled, writing to the local ledger only');
    return null;
  }

  return createSupabaseLedgerStore({ supabaseUrl, serviceRoleKey });
}
