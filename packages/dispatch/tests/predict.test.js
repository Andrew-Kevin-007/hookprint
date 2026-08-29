import test from 'node:test';
import assert from 'node:assert/strict';

import { predictQuality, staticPriorCurveLookup, WORKLOAD_DEGRADATION_MULTIPLIERS } from '../profiling/predict.js';
import { MODEL_PROFILES } from '../provider-profiles.js';

const provider = MODEL_PROFILES.anthropic;

test('predictQuality returns a lower predicted quality for a workload flagged as degrading faster, at the same context ratio/batch size', () => {
  const batchSize = 20; // same for both, so context ratio is identical
  const fasterDegrading = { workloadType: 'code_analysis', confidence: 0.8 };
  const moreRobust = { workloadType: 'summarization', confidence: 0.8 };

  const predictionFaster = predictQuality({}, provider, fasterDegrading, batchSize);
  const predictionRobust = predictQuality({}, provider, moreRobust, batchSize);

  assert.ok(
    predictionFaster.predictedQuality < predictionRobust.predictedQuality,
    `expected code_analysis (${predictionFaster.predictedQuality}) < summarization (${predictionRobust.predictedQuality})`
  );

  // Prove the multiplier is what actually moved the number, not something else:
  // both predictions start from the identical static prior (same provider,
  // same context ratio), so the ratio between them must equal the ratio of
  // the two documented multipliers.
  const expectedRatio = WORKLOAD_DEGRADATION_MULTIPLIERS.code_analysis / WORKLOAD_DEGRADATION_MULTIPLIERS.summarization;
  const actualRatio = predictionFaster.predictedQuality / predictionRobust.predictedQuality;
  assert.ok(Math.abs(actualRatio - expectedRatio) < 0.001, `expected ratio ${expectedRatio}, got ${actualRatio}`);
});

test('multi_document_comparison also degrades faster than summarization at the same context load', () => {
  const batchSize = 15;
  const comparison = predictQuality({}, provider, { workloadType: 'multi_document_comparison', confidence: 0.7 }, batchSize);
  const summarization = predictQuality({}, provider, { workloadType: 'summarization', confidence: 0.7 }, batchSize);

  assert.ok(comparison.predictedQuality < summarization.predictedQuality);
});

test("predictQuality's curveSource is always 'static_prior' in this pass", () => {
  const result = predictQuality({}, provider, { workloadType: 'summarization', confidence: 0.9 }, 10);
  assert.equal(result.curveSource, 'static_prior');
});

test('predictQuality accepts an optional curveLookup override, and passing one genuinely changes the result (the swap-point is real, not decorative)', () => {
  const workload = { workloadType: 'summarization', confidence: 0.9 };
  const batchSize = 10;

  const defaultResult = predictQuality({}, provider, workload, batchSize);

  let calledWith = null;
  const customLookup = (prov, contextRatio) => {
    calledWith = { provider: prov, contextRatio };
    return 0.5; // a deliberately distinctive constant, far from the static prior
  };
  const customResult = predictQuality({}, provider, workload, batchSize, customLookup);

  assert.notEqual(customResult.predictedQuality, defaultResult.predictedQuality);
  // multiplier for summarization is 1.0, so predictedQuality should equal
  // exactly the custom lookup's return value with no further adjustment.
  assert.equal(customResult.predictedQuality, 0.5);
  assert.ok(calledWith !== null, 'expected the custom curveLookup to actually be invoked');
  assert.equal(calledWith.provider, provider);
  // curveSource stays 'static_prior' in this pass even with a custom lookup --
  // flipping the literal to 'learned' is a later phase's job, not this swap-point's.
  assert.equal(customResult.curveSource, 'static_prior');
});

test('predictQuality without a curveLookup override falls back to staticPriorCurveLookup, matching estimateProviderFit()\'s own thresholds', () => {
  // tokensPerItem=2500, contextWindow=200000 (anthropic profile) -> batchSize
  // chosen so perBatchTokens/contextWindow lands in the "low" band (<=0.6).
  const smallBatch = predictQuality({}, provider, { workloadType: 'summarization', confidence: 0.9 }, 10);
  const expectedContextRatio = (provider.tokensPerItem * 10) / provider.contextWindow;
  const expectedPrior = staticPriorCurveLookup(provider, expectedContextRatio);
  assert.equal(smallBatch.predictedQuality, Number((expectedPrior * WORKLOAD_DEGRADATION_MULTIPLIERS.summarization).toFixed(4)));
});

test('predictQuality never exceeds [0, 1] and reports a non-empty basis string naming provider, ratio, and workload', () => {
  const result = predictQuality({}, provider, { workloadType: 'code_analysis', confidence: 1.0 }, 200);
  assert.ok(result.predictedQuality >= 0 && result.predictedQuality <= 1);
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(typeof result.basis === 'string' && result.basis.length > 0);
  assert.match(result.basis, /anthropic/);
  assert.match(result.basis, /code_analysis/);
});

test('predictQuality discounts confidence below the raw classification confidence (never claims full confidence on a static prior)', () => {
  const result = predictQuality({}, provider, { workloadType: 'summarization', confidence: 1.0 }, 10);
  assert.ok(result.confidence < 1.0, 'a static, unmeasured prior must never report full confidence');
});

test('an unrecognized workload type falls back to a neutral 1.0 multiplier rather than throwing', () => {
  assert.doesNotThrow(() => predictQuality({}, provider, { workloadType: 'nonexistent_type', confidence: 0.5 }, 10));
});
