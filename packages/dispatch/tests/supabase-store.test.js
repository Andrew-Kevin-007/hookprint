/**
 * QUORUM dispatch — tests/supabase-store.test.js
 *
 * Two things this suite proves:
 *   1. The graceful-degradation contract (`maybeCreateSupabaseLedgerStore()`
 *      returns `null`, never throws, when SUPABASE_URL/
 *      SUPABASE_SERVICE_ROLE_KEY are absent) — this MUST stay green on a
 *      fresh clone with zero Supabase credentials, exactly like every other
 *      test in this package.
 *   2. `createSupabaseLedgerStore()`'s own input validation (matching
 *      identity-registry-supabase.js's `assertNonEmptyString` discipline).
 *
 * A REAL round-trip against a live Supabase project (insert a row into
 * dispatch_ledger_events, read it back) is gated behind real credentials,
 * SKIPPED (not failed) otherwise — the exact same pattern
 * packages/stake/test/identity-registry-supabase.test.js already uses for
 * its own live-Supabase suite, translated to node:test's `{ skip }` option
 * since this package uses `node --test`, not Mocha.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSupabaseLedgerStore, maybeCreateSupabaseLedgerStore } from '../ledger/supabase-store.js';

test('maybeCreateSupabaseLedgerStore returns null, and logs, when credentials are absent', () => {
  const logged = [];
  const store = maybeCreateSupabaseLedgerStore({ env: {}, logger: (msg) => logged.push(msg) });

  assert.equal(store, null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /SUPABASE_URL.*SUPABASE_SERVICE_ROLE_KEY.*not set/);
});

test('maybeCreateSupabaseLedgerStore returns null when only one of the two env vars is set', () => {
  assert.equal(maybeCreateSupabaseLedgerStore({ env: { SUPABASE_URL: 'https://example.supabase.co' }, logger: () => {} }), null);
  assert.equal(maybeCreateSupabaseLedgerStore({ env: { SUPABASE_SERVICE_ROLE_KEY: 'fake-key' }, logger: () => {} }), null);
});

test('maybeCreateSupabaseLedgerStore returns a real store (appendEvent function) when both env vars are set', () => {
  const store = maybeCreateSupabaseLedgerStore({
    env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'fake-key' },
    logger: () => {}
  });
  assert.notEqual(store, null);
  assert.equal(typeof store.appendEvent, 'function');
});

test('createSupabaseLedgerStore throws on a missing/empty supabaseUrl or serviceRoleKey', () => {
  assert.throws(() => createSupabaseLedgerStore({ serviceRoleKey: 'fake-key' }), /supabaseUrl must be a non-empty string/);
  assert.throws(() => createSupabaseLedgerStore({ supabaseUrl: 'https://example.supabase.co' }), /serviceRoleKey must be a non-empty string/);
  assert.throws(() => createSupabaseLedgerStore({ supabaseUrl: '', serviceRoleKey: 'fake-key' }), /supabaseUrl must be a non-empty string/);
});

test('appendEvent rejects a non-object event before any network call', async () => {
  const store = createSupabaseLedgerStore({ supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'fake-key' });
  await assert.rejects(() => store.appendEvent(null), /event must be an object/);
  await assert.rejects(() => store.appendEvent('not-an-object'), /event must be an object/);
});

/**
 * Real, live round-trip against dispatch_ledger_events — gated exactly like
 * bin/quorum.js's cmdCampaign() gates a provider on its API key, and exactly
 * like packages/stake/test/identity-registry-supabase.test.js gates its own
 * live suite. SKIPPED (not failed) with no SUPABASE_URL/
 * SUPABASE_SERVICE_ROLE_KEY in the environment.
 */
const HAS_SUPABASE_CREDENTIALS = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
if (!HAS_SUPABASE_CREDENTIALS) {
  console.log('  [skip] ledger/supabase-store: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in .env');
}

test(
  'live: appendEvent really inserts a row into dispatch_ledger_events',
  { skip: !HAS_SUPABASE_CREDENTIALS },
  async () => {
    const { createClient } = await import('@supabase/supabase-js');
    const rawClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const store = createSupabaseLedgerStore({
      supabaseUrl: process.env.SUPABASE_URL,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
    });

    const taskId = `test-supabase-store-${Date.now()}`;
    const event = {
      eventType: 'route-decision-recorded',
      taskId,
      provider: 'groq',
      routeId: null,
      payload: { selectedProvider: 'groq', qualityTarget: 0.85 },
      timestamp: new Date().toISOString()
    };

    try {
      await store.appendEvent(event);

      const { data, error } = await rawClient.from('dispatch_ledger_events').select('*').eq('task_id', taskId).maybeSingle();
      assert.equal(error, null);
      assert.ok(data, 'expected the inserted row to be readable back');
      assert.equal(data.event_type, 'route-decision-recorded');
      assert.equal(data.provider, 'groq');
      assert.deepEqual(data.payload, { selectedProvider: 'groq', qualityTarget: 0.85 });
    } finally {
      await rawClient.from('dispatch_ledger_events').delete().eq('task_id', taskId);
    }
  }
);
