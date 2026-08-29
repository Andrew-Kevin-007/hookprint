import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSafeBatchSize, rankProviders, MODEL_PROFILES } from '../provider-profiles.js';

test('computeSafeBatchSize respects provider safe context limits', () => {
  const profile = MODEL_PROFILES.anthropic;
  const size = computeSafeBatchSize(profile, 120);

  assert.ok(size > 0);
  assert.ok(size <= profile.maxBatchSize);
  assert.ok(size < 120);
});

test('rankProviders prefers the provider with the best safe quality fit', () => {
  const task = { items: Array.from({ length: 120 }, (_, idx) => idx) };
  const ranked = rankProviders(task, [MODEL_PROFILES.anthropic, MODEL_PROFILES.openai, MODEL_PROFILES.local]);

  assert.equal(ranked[0].provider, 'anthropic');
  assert.ok(ranked[0].qualityEstimate >= ranked[1].qualityEstimate);
  assert.ok(ranked[0].safeBatch > 0);
});

test('MODEL_PROFILES includes the four free-tier providers (groq, cerebras, gemini, openrouter), each shaped like the existing entries plus a rateLimits field', () => {
  for (const name of ['groq', 'cerebras', 'gemini', 'openrouter']) {
    const profile = MODEL_PROFILES[name];
    assert.ok(profile, `expected MODEL_PROFILES.${name} to exist`);
    assert.equal(profile.name, name);
    assert.ok(Number.isFinite(profile.contextWindow) && profile.contextWindow > 0);
    assert.ok(profile.safeContextRatio > 0 && profile.safeContextRatio <= 1);
    assert.ok(Number.isFinite(profile.tokensPerItem) && profile.tokensPerItem > 0);
    assert.ok(Number.isFinite(profile.maxBatchSize) && profile.maxBatchSize > 0);
    assert.ok(profile.qualityCurve && typeof profile.qualityCurve.low === 'number');

    // Each new provider reuses the 'local' entry's conservative prior
    // curve verbatim (documented as unmeasured), never a fabricated
    // confident-looking curve.
    assert.deepEqual(profile.qualityCurve, MODEL_PROFILES.local.qualityCurve);

    // rateLimits is the new field these four entries add over
    // anthropic/openai/local.
    assert.ok(profile.rateLimits, `expected MODEL_PROFILES.${name}.rateLimits to exist`);
    assert.ok('rpm' in profile.rateLimits);
    assert.ok('rpd' in profile.rateLimits);
    assert.ok('tpd' in profile.rateLimits);
  }
});

test('computeSafeBatchSize and rankProviders work identically for the four new provider profiles (no special-casing required)', () => {
  const task = { items: Array.from({ length: 200 }, (_, idx) => idx) };
  const newProviders = [MODEL_PROFILES.groq, MODEL_PROFILES.cerebras, MODEL_PROFILES.gemini, MODEL_PROFILES.openrouter];

  for (const profile of newProviders) {
    const size = computeSafeBatchSize(profile, task.items.length);
    assert.ok(size > 0);
    assert.ok(size <= profile.maxBatchSize);
  }

  const ranked = rankProviders(task, newProviders);
  assert.equal(ranked.length, newProviders.length);
  for (const entry of ranked) {
    assert.ok(entry.safeBatch > 0);
    assert.ok(entry.totalBatches >= 1);
  }
});
