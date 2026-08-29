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
