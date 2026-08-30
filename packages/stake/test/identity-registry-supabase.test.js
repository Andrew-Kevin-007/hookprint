const { expect } = require('chai');

const { createSupabaseIdentityRegistry } = require('../policy/identity-registry-supabase');

/**
 * Asserts `promise` rejects, optionally matching `messagePattern` against
 * the rejection's message. Written by hand rather than pulling in
 * chai-as-promised (present only transitively via hardhat's own dependency
 * chain, not a direct devDependency of this package) purely to avoid
 * depending on an untracked plugin.
 */
async function expectRejection(promise, messagePattern) {
  let threw = false;
  let err;
  try {
    await promise;
  } catch (e) {
    threw = true;
    err = e;
  }
  expect(threw, 'expected the promise to reject, but it resolved').to.equal(true);
  if (messagePattern) {
    expect(err.message).to.match(messagePattern);
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HAS_SUPABASE_CREDENTIALS = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

/**
 * Gated exactly like bin/quorum.js's cmdCampaign() gates a provider on its
 * API key: no SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY in packages/stake/.env
 * -> this whole suite is SKIPPED (Mocha `describe.skip`), never failed.
 * `npm run test:stake` must stay fully green on a machine with zero
 * Supabase credentials, same as `quorum campaign` prints a clean "no
 * credentials found" message rather than erroring when no provider key is
 * set.
 */
const maybeDescribe = HAS_SUPABASE_CREDENTIALS ? describe : describe.skip;

if (!HAS_SUPABASE_CREDENTIALS) {
  // Visible, not silent -- same discipline evaluateAndSlash's own skip path
  // uses (skipped:true always carries a skipReason).
  console.log('  [skip] policy/identity-registry-supabase: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in packages/stake/.env');
}

maybeDescribe('policy/identity-registry-supabase (real Supabase project)', function () {
  this.timeout(20000);

  const AGENT_A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
  const registeredKeyIds = [];

  let registry;
  let rawClient;

  before(function () {
    registry = createSupabaseIdentityRegistry({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY });
    // Only used here, in the test file, to clean up rows this suite writes --
    // the module under test never needs a raw client handed back to a caller.
    const { createClient } = require('@supabase/supabase-js');
    rawClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  /** Every test registers under a fresh, unique keyId so repeated runs never collide on real data. */
  function freshKeyId(label) {
    const keyId = `test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    registeredKeyIds.push(keyId);
    return keyId;
  }

  after(async function () {
    if (registeredKeyIds.length === 0) return;
    await rawClient.from('identity_registry').delete().in('key_id', registeredKeyIds);
  });

  it('register + lookup round-trip against the real table', async function () {
    const keyId = freshKeyId('roundtrip');
    await registry.register(keyId, AGENT_A);
    expect(await registry.lookup(keyId)).to.equal(AGENT_A);
    expect(await registry.has(keyId)).to.equal(true);
  });

  it('lookup of an unregistered keyId resolves to null, never rejects', async function () {
    const keyId = freshKeyId('unregistered'); // never actually registered
    expect(await registry.lookup(keyId)).to.equal(null);
    expect(await registry.has(keyId)).to.equal(false);
  });

  it('re-registering the same keyId overwrites the prior binding (last write wins)', async function () {
    const keyId = freshKeyId('overwrite');
    const AGENT_B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    await registry.register(keyId, AGENT_A);
    await registry.register(keyId, AGENT_B);
    expect(await registry.lookup(keyId)).to.equal(AGENT_B);
  });

  it('register rejects a malformed EVM address before any network write', async function () {
    const keyId = freshKeyId('malformed');
    await expectRejection(registry.register(keyId, 'not-an-address'), /well-formed EVM address/);
    expect(await registry.has(keyId)).to.equal(false);
  });

  it('register rejects an empty keyId or address', async function () {
    await expectRejection(registry.register('', AGENT_A));
    await expectRejection(registry.register(freshKeyId('empty-address'), ''));
  });
});
