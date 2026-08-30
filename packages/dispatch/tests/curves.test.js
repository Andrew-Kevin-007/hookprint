import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendEvent } from '../ledger/store.js';
import { buildQualityScoreEvent, DETERMINISTIC_WEIGHT, CONSISTENCY_WEIGHT } from '../quality/score.js';
import { fitDegradationCurve, learnedCurveLookup, deriveWorkloadType, MIN_BUCKET_SAMPLES } from '../ledger/curves.js';
import { staticPriorCurveLookup } from '../profiling/predict.js';
import { classifyWorkload } from '../profiling/classify.js';
import { rankProviders, MODEL_PROFILES } from '../provider-profiles.js';

/* -------------------------------------------------------------------------- */
/* Test helpers                                                             */
/* -------------------------------------------------------------------------- */

function makeTempLedgerDir() {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-curves-test-'));
  return { dir, path: join(dir, 'ledger.jsonl') };
}

/** Write one real `batch-quality-scored` event via the REAL builder used in
 * production (`quality/score.js`'s `buildQualityScoreEvent()`), not a
 * hand-rolled object shape, so this test suite is pinned to the real
 * contract rather than a guess at it. `workloadType` is optional, same
 * additive discipline as the real function. */
function writeQualityEvent(ledgerPath, { taskId = 'task-fixture', provider, batchIndex = 0, contextRatio, combinedScore, workloadType }) {
  const scoreResult = {
    combinedScore,
    deterministicScore: combinedScore,
    consistencyScore: combinedScore,
    weights: { deterministic: DETERMINISTIC_WEIGHT, consistency: CONSISTENCY_WEIGHT },
    reasons: ['synthetic_fixture_for_curves_test']
  };
  const event = buildQualityScoreEvent({ taskId, provider, routeId: null, batchIndex, contextRatio, scoreResult, workloadType });
  appendEvent(ledgerPath, event);
  return event;
}

function seedBucket(ledgerPath, provider, contextRatio, scores, workloadType) {
  scores.forEach((combinedScore, i) => {
    writeQualityEvent(ledgerPath, { taskId: `task-${provider}-${contextRatio}-${i}`, provider, batchIndex: i, contextRatio, combinedScore, workloadType });
  });
}

/* -------------------------------------------------------------------------- */
/* Fixture tasks -- each classifies deterministically and distinctly via the  */
/* REAL classifyWorkload() cascade (verified directly below), used across the */
/* workload-aware tests so nothing here guesses at classification behavior.  */
/* -------------------------------------------------------------------------- */

const TASK_CODE_ANALYSIS = {
  items: [
    {
      id: 'code-a',
      content: '```js\nfunction add(a, b) { return a + b; }\nexport class Calc { constructor() { this.total = 0; } }\n```'
    }
  ]
};

const TASK_SUMMARIZATION = {
  items: [{ id: 'summ-a', content: 'Please summarize this long report. '.repeat(60) }]
};

const TASK_MULTI_DOC_COMPARISON = {
  items: [
    { id: 'cmp-a', content: 'Compare document A and document B in terms of structure and content. This is a comparison task about the versus of two similar things.' },
    { id: 'cmp-b', content: 'Compare document A and document B in terms of layout and outcome. This is a comparison task about the versus of two similar things.' }
  ]
};

/* -------------------------------------------------------------------------- */
/* 1. fitDegradationCurve -- real arithmetic mean, per bucket                */
/* -------------------------------------------------------------------------- */

test('fitDegradationCurve: with enough samples in every bucket, curve values are the exact arithmetic mean of what was fed in', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.ok(MIN_BUCKET_SAMPLES >= 5, 'sanity: this test assumes at least 5 samples are required per bucket');

  // low bucket (contextRatio <= 0.6): 6 samples, mean = 0.85
  const lowScores = [0.8, 0.85, 0.9, 0.8, 0.85, 0.9]; // sum 5.10 / 6 = 0.85
  // medium bucket (0.6 < contextRatio <= 0.9): 6 samples, mean = 0.7
  const mediumScores = [0.6, 0.7, 0.8, 0.6, 0.7, 0.8]; // sum 4.20 / 6 = 0.7
  // high bucket (contextRatio > 0.9): 6 samples, mean = 0.5
  const highScores = [0.4, 0.5, 0.6, 0.4, 0.5, 0.6]; // sum 3.00 / 6 = 0.5

  seedBucket(path, 'anthropic', 0.3, lowScores);
  seedBucket(path, 'anthropic', 0.75, mediumScores);
  seedBucket(path, 'anthropic', 0.95, highScores);

  const fit = fitDegradationCurve(path, 'anthropic');

  assert.equal(fit.provider, 'anthropic');
  assert.equal(fit.sampleCount, 18);
  assert.equal(fit.method, 'learned');
  assert.equal(fit.confidence, 'medium', 'all 3 buckets learned but only 6 samples each (< 2x the min of 5) -- not yet "high"');
  assert.ok(Math.abs(fit.curve.low - 0.85) < 1e-9, `expected low bucket mean 0.85, got ${fit.curve.low}`);
  assert.ok(Math.abs(fit.curve.medium - 0.7) < 1e-9, `expected medium bucket mean 0.7, got ${fit.curve.medium}`);
  assert.ok(Math.abs(fit.curve.high - 0.5) < 1e-9, `expected high bucket mean 0.5, got ${fit.curve.high}`);
});

test('fitDegradationCurve: confidence is "high" once every bucket clears 2x the minimum threshold', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const deepScores = Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.77);
  seedBucket(path, 'openai', 0.3, deepScores);
  seedBucket(path, 'openai', 0.75, deepScores);
  seedBucket(path, 'openai', 0.95, deepScores);

  const fit = fitDegradationCurve(path, 'openai');
  assert.equal(fit.method, 'learned');
  assert.equal(fit.confidence, 'high');
  assert.ok(Math.abs(fit.curve.low - 0.77) < 1e-9);
});

/* -------------------------------------------------------------------------- */
/* 2. Per-bucket graceful degradation                                        */
/* -------------------------------------------------------------------------- */

test('fitDegradationCurve: a bucket with FEWER samples than the minimum threshold returns null for that bucket only -- other sufficiently-sampled buckets still return real values', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // low bucket: only 2 samples -- below MIN_BUCKET_SAMPLES (5).
  seedBucket(path, 'groq', 0.3, [0.9, 0.95]);
  // medium bucket: exactly MIN_BUCKET_SAMPLES samples -- sufficient.
  seedBucket(path, 'groq', 0.75, Array.from({ length: MIN_BUCKET_SAMPLES }, () => 0.6));
  // high bucket: no samples at all.

  const fit = fitDegradationCurve(path, 'groq');

  assert.equal(fit.method, 'learned', 'at least one bucket (medium) had enough data to learn from');
  assert.equal(fit.confidence, 'low', 'only 1 of 3 buckets learned -- a partial curve');
  assert.equal(fit.curve.low, null, 'low bucket had only 2 samples, below the threshold -- must be null, not a noisy 2-sample mean');
  assert.ok(Math.abs(fit.curve.medium - 0.6) < 1e-9, 'medium bucket had exactly the minimum and must return its real mean');
  assert.equal(fit.curve.high, null, 'high bucket had zero samples -- must be null');
  assert.equal(fit.sampleCount, 2 + MIN_BUCKET_SAMPLES);
});

test('fitDegradationCurve: real events exist for the provider, but not one single bucket cleared the threshold -- reports insufficient_data with a fully null curve, not a fabricated one', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  seedBucket(path, 'cerebras', 0.3, [0.9]); // 1 sample, low bucket
  seedBucket(path, 'cerebras', 0.75, [0.6, 0.65]); // 2 samples, medium bucket

  const fit = fitDegradationCurve(path, 'cerebras');
  assert.equal(fit.method, 'insufficient_data');
  assert.equal(fit.confidence, 'none');
  assert.equal(fit.curve, null);
  assert.equal(fit.sampleCount, 3, 'sampleCount still honestly reports the real events seen, even though nothing was learnable');
});

/* -------------------------------------------------------------------------- */
/* 3. Fail-closed: missing/unreadable ledger                                */
/* -------------------------------------------------------------------------- */

test('fitDegradationCurve: a missing ledger file returns the explicit insufficient_data/none shape, never throws, never a bare number', () => {
  const missingPath = join(tmpdir(), `quorum-curves-does-not-exist-${Date.now()}.jsonl`);

  assert.doesNotThrow(() => fitDegradationCurve(missingPath, 'anthropic'));
  const fit = fitDegradationCurve(missingPath, 'anthropic');

  assert.deepEqual(fit, {
    provider: 'anthropic',
    sampleCount: 0,
    curve: null,
    confidence: 'none',
    method: 'insufficient_data'
  });
  assert.notEqual(typeof fit, 'number', 'must never return a bare number that looks like a real measurement');
});

test('fitDegradationCurve: an unreadable ledger path (a directory, not a file) returns the same fail-closed shape, never throws', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-curves-unreadable-'));
  const dirAsLedgerPath = join(dir, 'looks-like-a-ledger-but-is-a-dir');
  mkdirSync(dirAsLedgerPath);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.doesNotThrow(() => fitDegradationCurve(dirAsLedgerPath, 'anthropic'));
  const fit = fitDegradationCurve(dirAsLedgerPath, 'anthropic');
  assert.equal(fit.confidence, 'none');
  assert.equal(fit.method, 'insufficient_data');
  assert.equal(fit.curve, null);
});

test('fitDegradationCurve: a ledger with events, but none for the requested provider, returns insufficient_data for that provider', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  seedBucket(path, 'anthropic', 0.3, Array.from({ length: MIN_BUCKET_SAMPLES }, () => 0.9));

  const fit = fitDegradationCurve(path, 'openai'); // different provider, zero events
  assert.equal(fit.sampleCount, 0);
  assert.equal(fit.curve, null);
  assert.equal(fit.confidence, 'none');
  assert.equal(fit.method, 'insufficient_data');
});

/* -------------------------------------------------------------------------- */
/* 4. learnedCurveLookup -- returns the learned value, not the static prior  */
/* -------------------------------------------------------------------------- */

test('learnedCurveLookup: when there is sufficient learned data for a provider/bucket, it returns the LEARNED value, not the static prior', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // anthropic's real static low-bucket prior is 0.94 (provider-profiles.js).
  // Rig the learned fixture to something clearly different: 0.5.
  const staticLowPrior = MODEL_PROFILES.anthropic.qualityCurve.low;
  assert.equal(staticLowPrior, 0.94, 'sanity check on the real static prior this test must differ from');

  seedBucket(path, 'anthropic', 0.3, Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.5));

  const lookup = learnedCurveLookup(path);
  const result = lookup(MODEL_PROFILES.anthropic, 0.3, null);

  assert.ok(Math.abs(result - 0.5) < 1e-9, `expected the learned value 0.5, got ${result}`);
  assert.notEqual(result, staticLowPrior);
});

/* -------------------------------------------------------------------------- */
/* 5. learnedCurveLookup -- real fallback to staticPriorCurveLookup          */
/* -------------------------------------------------------------------------- */

test('learnedCurveLookup: falls back to the REAL staticPriorCurveLookup (actually calling it) when there is no learned data', () => {
  const { dir, path } = makeTempLedgerDir();
  rmSync(dir, { recursive: true, force: true }); // ledger never existed / already gone -- guaranteed zero data

  // A synthetic provider with a distinctive qualityCurve unlike any real
  // entry in MODEL_PROFILES -- if the fallback value matches THIS exact
  // number, it proves staticPriorCurveLookup's own field-reading logic ran
  // (reused), not a duplicated/reimplemented copy of it.
  const fakeProvider = { name: 'totally-unseen-provider', qualityCurve: { low: 0.1234, medium: 0.2345, high: 0.3456 } };

  const lookup = learnedCurveLookup(path);
  const lowResult = lookup(fakeProvider, 0.3, null);
  const medResult = lookup(fakeProvider, 0.75, null);
  const highResult = lookup(fakeProvider, 0.95, null);

  assert.equal(lowResult, staticPriorCurveLookup(fakeProvider, 0.3, null));
  assert.equal(medResult, staticPriorCurveLookup(fakeProvider, 0.75, null));
  assert.equal(highResult, staticPriorCurveLookup(fakeProvider, 0.95, null));
  assert.equal(lowResult, 0.1234);
  assert.equal(medResult, 0.2345);
  assert.equal(highResult, 0.3456);
});

test('learnedCurveLookup: falls back per-bucket -- a provider with learned data in ONE bucket still gets the real static prior for a DIFFERENT bucket', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Only the low bucket has learned data for 'openai'.
  seedBucket(path, 'openai', 0.3, Array.from({ length: MIN_BUCKET_SAMPLES }, () => 0.42));

  const lookup = learnedCurveLookup(path);
  const lowResult = lookup(MODEL_PROFILES.openai, 0.3, null);
  const highResult = lookup(MODEL_PROFILES.openai, 0.95, null);

  assert.ok(Math.abs(lowResult - 0.42) < 1e-9, 'low bucket: learned value used');
  assert.equal(highResult, staticPriorCurveLookup(MODEL_PROFILES.openai, 0.95, null), 'high bucket: real static fallback, no learned data there');
  assert.equal(highResult, MODEL_PROFILES.openai.qualityCurve.high);
});

/* -------------------------------------------------------------------------- */
/* 6. rankProviders -- default behavior is byte-identical (no opts)         */
/* -------------------------------------------------------------------------- */

test('rankProviders: with no opts argument at all (or opts: {}), output is byte-identical to before this change -- zero behavior change for existing callers', () => {
  const task = { items: Array.from({ length: 120 }, (_, idx) => idx) };
  const providers = [MODEL_PROFILES.anthropic, MODEL_PROFILES.openai, MODEL_PROFILES.local];

  const noArgAtAll = rankProviders(task, providers);
  const explicitEmptyOpts = rankProviders(task, providers, {});

  // The known, pre-existing formula result for this exact fixture (also
  // covered by tests/provider-profiles.test.js's "prefers the best safe
  // quality fit" test): anthropic wins on qualityEstimate.
  const expected = [
    { provider: 'anthropic', safeBatch: 35, totalBatches: 4, estimatedTokens: 2500 * 120, qualityEstimate: 0.9, contextResetRequired: true },
    { provider: 'openai', safeBatch: 30, totalBatches: 4, estimatedTokens: 2300 * 120, qualityEstimate: 0.88, contextResetRequired: true },
    { provider: 'local', safeBatch: 2, totalBatches: 60, estimatedTokens: 1800 * 120, qualityEstimate: 0.66, contextResetRequired: true }
  ];

  assert.deepEqual(noArgAtAll, expected, 'no-opts call must match the pre-existing static-curve formula exactly');
  assert.deepEqual(explicitEmptyOpts, expected, 'opts:{} call must match the pre-existing static-curve formula exactly');
  assert.deepEqual(noArgAtAll, explicitEmptyOpts, 'omitting opts vs. passing {} must be byte-identical');
});

/* -------------------------------------------------------------------------- */
/* 7. rankProviders -- opts.ledgerPath actually changes the ranking          */
/* -------------------------------------------------------------------------- */

test('rankProviders: opts.ledgerPath with strong learned data for one provider changes its ranking position relative to calling without the ledger', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const task = { items: Array.from({ length: 120 }, (_, idx) => idx) };
  const providers = [MODEL_PROFILES.anthropic, MODEL_PROFILES.openai, MODEL_PROFILES.local];

  // Without a ledger: 'local' ranks LAST (static high-bucket prior 0.66,
  // since 120 items / safeBatch 2 = 60 batches -> the 'high' bucket applies).
  const withoutLedger = rankProviders(task, providers);
  assert.equal(withoutLedger[0].provider, 'anthropic');
  assert.equal(withoutLedger[withoutLedger.length - 1].provider, 'local');

  // Seed the ledger with strong learned data for 'local' in exactly the
  // bucket its totalBatches (60, > 4) selects: 'high'.
  seedBucket(path, 'local', 0.95, Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.99));

  const withLedger = rankProviders(task, providers, { ledgerPath: path });
  assert.equal(withLedger[0].provider, 'local', 'local should now rank FIRST -- its learned high-bucket quality (0.99) beats anthropic\'s static medium-bucket prior (0.9)');
  assert.ok(
    withLedger[0].qualityEstimate > withoutLedger.find((r) => r.provider === 'local').qualityEstimate,
    'local\'s own quality estimate must have gone up from the learned data, proving the wiring actually affects the output'
  );

  // Providers with no ledger data at all fall back to their exact static values, unaffected.
  const anthropicWithLedger = withLedger.find((r) => r.provider === 'anthropic');
  const anthropicWithoutLedger = withoutLedger.find((r) => r.provider === 'anthropic');
  assert.equal(anthropicWithLedger.qualityEstimate, anthropicWithoutLedger.qualityEstimate);
});

/* -------------------------------------------------------------------------- */
/* 8. WORKLOAD-AWARE fitDegradationCurve -- regression, then real wiring     */
/* -------------------------------------------------------------------------- */

test('fitDegradationCurve: workloadType OMITTED -- regression, byte-identical to pre-workload-awareness behavior on fixture data that ALSO carries workload tags', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Same fixture shape as the very first test in this file, but now some
  // events also carry a workloadType tag -- proving the tag is silently
  // irrelevant to the 2-arg call, not merely untested.
  const lowScores = [0.8, 0.85, 0.9, 0.8, 0.85, 0.9]; // mean 0.85
  seedBucket(path, 'anthropic-regression', 0.3, lowScores.slice(0, 3), 'code_analysis');
  seedBucket(path, 'anthropic-regression', 0.3, lowScores.slice(3), undefined);

  const fit = fitDegradationCurve(path, 'anthropic-regression');

  assert.deepEqual(
    Object.keys(fit).sort(),
    ['confidence', 'curve', 'method', 'provider', 'sampleCount'].sort(),
    'omitting workloadType must produce EXACTLY the pre-existing 5 keys -- no workloadType/bucketSources leakage'
  );
  assert.equal(fit.method, 'learned');
  assert.ok(Math.abs(fit.curve.low - 0.85) < 1e-9, `expected the provider-wide mean 0.85 regardless of the tags present, got ${fit.curve.low}`);
  assert.equal(fit.sampleCount, 6, 'sampleCount counts every relevant event for the provider, tagged or not');
});

test('fitDegradationCurve: workloadType SUPPLIED with enough same-workload-type samples returns the workload-specific value, DIFFERENT from the all-workload-types value for that bucket', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // low bucket (contextRatio 0.3): 6 'code_analysis' samples at 0.30, PLUS 6
  // 'summarization' samples at 0.95 -- the provider-wide mean (0.625) is
  // deliberately far from either tagged mean, so a test that accidentally
  // read the provider-wide value instead of the workload-specific one would
  // fail loudly rather than by coincidence.
  seedBucket(path, 'groq-wa1', 0.3, Array.from({ length: 6 }, () => 0.3), 'code_analysis');
  seedBucket(path, 'groq-wa1', 0.3, Array.from({ length: 6 }, () => 0.95), 'summarization');

  const providerWideFit = fitDegradationCurve(path, 'groq-wa1'); // no filter -- sanity baseline
  assert.ok(Math.abs(providerWideFit.curve.low - 0.625) < 1e-9, `sanity: expected provider-wide mean 0.625, got ${providerWideFit.curve.low}`);

  const fit = fitDegradationCurve(path, 'groq-wa1', 'code_analysis');
  assert.equal(fit.workloadType, 'code_analysis');
  assert.ok(Math.abs(fit.curve.low - 0.3) < 1e-9, `expected the workload-specific mean 0.3, got ${fit.curve.low}`);
  assert.notEqual(fit.curve.low, providerWideFit.curve.low, 'must differ from the all-workload-types value for the same bucket');
  assert.equal(fit.bucketSources.low, 'workload_specific');
});

test('fitDegradationCurve: per-bucket independence -- one bucket falls back to the provider-wide value (insufficient workload-specific samples), while a DIFFERENT bucket in the SAME call has enough workload-specific samples and returns its specific value', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // low bucket (0.3): 6 'code_analysis' samples at 0.20 -- sufficient workload-specific data.
  seedBucket(path, 'groq-wa2', 0.3, Array.from({ length: 6 }, () => 0.2), 'code_analysis');

  // medium bucket (0.75): only 2 'code_analysis' samples at 0.10 (insufficient),
  // PLUS 6 'reasoning' samples at 0.70 -- provider-wide pool for this bucket
  // is 8 samples (sufficient), mean = (0.10*2 + 0.70*6) / 8 = 0.55.
  seedBucket(path, 'groq-wa2', 0.75, Array.from({ length: 2 }, () => 0.1), 'code_analysis');
  seedBucket(path, 'groq-wa2', 0.75, Array.from({ length: 6 }, () => 0.7), 'reasoning');

  // high bucket: no data at all.

  const fit = fitDegradationCurve(path, 'groq-wa2', 'code_analysis');

  assert.ok(Math.abs(fit.curve.low - 0.2) < 1e-9, `low bucket: expected workload-specific mean 0.2, got ${fit.curve.low}`);
  assert.equal(fit.bucketSources.low, 'workload_specific');

  assert.ok(Math.abs(fit.curve.medium - 0.55) < 1e-9, `medium bucket: expected provider-wide fallback mean 0.55, got ${fit.curve.medium}`);
  assert.equal(fit.bucketSources.medium, 'provider_wide', 'medium bucket only had 2 workload-specific samples -- below MIN_BUCKET_SAMPLES -- must fall back');

  assert.equal(fit.curve.high, null, 'high bucket: zero samples of any kind -- must be null');
  assert.equal(fit.bucketSources.high, null);

  assert.equal(fit.method, 'learned', 'at least one bucket learned -- the whole curve is not insufficient_data');
});

/* -------------------------------------------------------------------------- */
/* 9. learnedCurveLookup -- genuinely workload-aware, not decorative         */
/* -------------------------------------------------------------------------- */

test('learnedCurveLookup: produces a DIFFERENT result for the same (provider, contextRatio) when called with two mock tasks that classify to different workload types', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Sanity: the two fixture tasks really do classify to different types via
  // the REAL classifyWorkload() cascade -- not asserted as a given.
  assert.equal(classifyWorkload(TASK_CODE_ANALYSIS).workloadType, 'code_analysis');
  assert.equal(classifyWorkload(TASK_SUMMARIZATION).workloadType, 'summarization');

  seedBucket(path, 'anthropic', 0.3, Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.3), 'code_analysis');
  seedBucket(path, 'anthropic', 0.3, Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.95), 'summarization');

  const lookup = learnedCurveLookup(path);
  const resultForCode = lookup(MODEL_PROFILES.anthropic, 0.3, TASK_CODE_ANALYSIS);
  const resultForSummary = lookup(MODEL_PROFILES.anthropic, 0.3, TASK_SUMMARIZATION);

  assert.ok(Math.abs(resultForCode - 0.3) < 1e-9, `expected the code_analysis-specific value 0.3, got ${resultForCode}`);
  assert.ok(Math.abs(resultForSummary - 0.95) < 1e-9, `expected the summarization-specific value 0.95, got ${resultForSummary}`);
  assert.notEqual(resultForCode, resultForSummary, 'the same provider/contextRatio must produce genuinely different results for different workload types');
});

test('deriveWorkloadType: reuses the real classifyWorkload() cascade, and returns undefined (not a string) for a missing task', () => {
  assert.equal(deriveWorkloadType(TASK_CODE_ANALYSIS), 'code_analysis');
  assert.equal(deriveWorkloadType(TASK_MULTI_DOC_COMPARISON), 'multi_document_comparison');
  assert.equal(deriveWorkloadType(null), undefined);
  assert.equal(deriveWorkloadType(undefined), undefined);
});

/* -------------------------------------------------------------------------- */
/* 10. rankProviders -- workload-aware ranking genuinely differentiates      */
/* -------------------------------------------------------------------------- */

test('rankProviders: opts.ledgerPath + a task with strong SAME-workload-type learned data ranks a provider differently than the same call with a task classifying to a workload type with NO learned data (graceful provider-wide fallback instead)', (t) => {
  const { dir, path } = makeTempLedgerDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const codeItem = { id: 'code-a', content: '```js\nfunction add(a, b) { return a + b; }\nexport class Calc { constructor() { this.total = 0; } }\n```' };
  const cmpBase = 'Compare document A and document B in terms of structure and content. This is a comparison task about the versus of two similar things.';
  const taskCode = { items: Array.from({ length: 10 }, (_, i) => ({ ...codeItem, id: `code-${i}` })) };
  const taskCompare = { items: Array.from({ length: 10 }, (_, i) => ({ id: `cmp-${i}`, content: `${cmpBase} variant ${i}` })) };

  assert.equal(classifyWorkload(taskCode).workloadType, 'code_analysis');
  assert.equal(classifyWorkload(taskCompare).workloadType, 'multi_document_comparison');

  const providers = [MODEL_PROFILES.anthropic, MODEL_PROFILES.openai, MODEL_PROFILES.local];

  // With 10 items, 'local' lands on totalBatches=5 (>4) -> its 'high' bucket
  // (contextRatio > 0.9) is the one rankProviders() will read. Seed it with
  // STRONG 'code_analysis' data (0.99) plus a differently-tagged pool
  // (0.50) so the provider-wide fallback (0.745) is measurably different
  // from the workload-specific value (0.99) -- a lookup that silently
  // ignored the workload tag would return 0.745 in both calls below.
  seedBucket(path, 'local', 0.95, Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.99), 'code_analysis');
  seedBucket(path, 'local', 0.95, Array.from({ length: MIN_BUCKET_SAMPLES * 2 }, () => 0.5), 'summarization');

  const rankedForCode = rankProviders(taskCode, providers, { ledgerPath: path });
  const rankedForCompare = rankProviders(taskCompare, providers, { ledgerPath: path });

  const localForCode = rankedForCode.find((r) => r.provider === 'local');
  const localForCompare = rankedForCompare.find((r) => r.provider === 'local');

  assert.ok(Math.abs(localForCode.qualityEstimate - 0.99) < 1e-9, `expected local's code_analysis-specific quality 0.99, got ${localForCode.qualityEstimate}`);
  assert.ok(Math.abs(localForCompare.qualityEstimate - 0.745) < 1e-9, `expected local's provider-wide fallback quality 0.745 (no multi_document_comparison data exists), got ${localForCompare.qualityEstimate}`);
  assert.notEqual(localForCode.qualityEstimate, localForCompare.qualityEstimate, 'rankProviders must genuinely consume the workload dimension, not just accept it silently');

  // The ranking POSITION changes too: local's workload-specific 0.99 beats
  // every static prior, so it ranks first for the code task; with no
  // matching workload data it falls back to 0.745, well below anthropic's
  // static low-bucket prior (0.94), so it no longer ranks first.
  assert.equal(rankedForCode[0].provider, 'local', 'local should rank FIRST when its own learned workload-specific data applies');
  assert.notEqual(rankedForCompare[0].provider, 'local', 'local should NOT rank first once it falls back to the weaker provider-wide value');
});
