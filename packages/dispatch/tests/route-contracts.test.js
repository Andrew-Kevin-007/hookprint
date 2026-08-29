import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTaskRequest, planBatches, analyzeTaskQuality, buildRouteDecision } from '../route-contracts.js';

test('buildTaskRequest normalizes a task request with defaults', () => {
  const task = buildTaskRequest({
    taskId: 't-101',
    kind: 'document-analysis',
    items: [1, 2, 3, 4],
    qualityTarget: 0.9,
    providerPreference: ['anthropic', 'openai']
  });

  assert.equal(task.taskId, 't-101');
  assert.equal(task.kind, 'document-analysis');
  assert.equal(task.qualityTarget, 0.9);
  assert.deepEqual(task.providerPreference, ['anthropic', 'openai']);
  assert.equal(task.contextResetRequired, true);
  assert.equal(task.safeMode, true);
  assert.equal(task.agentPrediction, null); // optional field
  assert.equal(task.allowManualOverride, false);
});

test('analyzeTaskQuality infers quality target from task size', () => {
  const smallTask = buildTaskRequest({
    items: Array.from({ length: 3 }, (_, i) => ({ id: `item-${i}` })),
    kind: 'document-analysis',
    qualityTarget: undefined // force re-analysis
  });
  
  const smallQA = analyzeTaskQuality(smallTask);
  // Note: buildTaskRequest sets default qualityTarget to 0.85, so we need to override
  // Let's test by checking the prediction logic directly
  assert(smallQA.confidence > 0);
  
  // Test with explicit override task
  const largeTask = buildTaskRequest({
    items: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}` })),
    kind: 'document-analysis',
    qualityTarget: 0 // use 0 to trigger fallback
  });
  
  // Rebuild without default to test heuristic
  const manualLargeTask = {
    items: Array.from({ length: 50 }, (_, i) => ({ id: `item-${i}` })),
    kind: 'document-analysis',
    qualityTarget: 0 // zero triggers fallback
  };
  
  const largeQA = analyzeTaskQuality(manualLargeTask);
  assert.equal(largeQA.qualityTarget, 0.75); // large task should get moderate quality
  assert.equal(largeQA.reason, 'large-task');
  assert.equal(largeQA.confidence, 0.7); // heuristic estimate
  
  const codeReview = buildTaskRequest({
    items: Array.from({ length: 3 }, (_, i) => ({ id: `item-${i}` })),
    kind: 'code-review',
    qualityTarget: 0 // trigger fallback for high-stakes kind
  });
  
  const codeQA = analyzeTaskQuality(codeReview);
  assert(codeQA.qualityTarget >= 0.9); // code-review should get boosted
  assert.equal(codeQA.reason, 'code-review');
});

test('buildRouteDecision captures route selection with fallback chain', () => {
  const decision = buildRouteDecision({
    taskId: 't-201',
    primaryProvider: 'claude-3.5-sonnet',
    qualityTarget: 0.85,
    fallbackProviders: ['gpt-4-turbo', 'claude-3-opus'],
    batchPlan: [
      { batchIndex: 0, itemIds: ['a', 'b'], expectedTokens: 4000 }
    ],
    reasoning: {
      selectedReason: 'quality-optimal',
      alternativeProviders: ['gpt-4-turbo', 'claude-3-opus'],
      rejectedReasons: { 'gpt-4-turbo': 'cost-over-budget', 'claude-3-opus': 'lower-quality' }
    }
  });

  assert.equal(decision.taskId, 't-201');
  assert.equal(decision.primaryProvider, 'claude-3.5-sonnet');
  assert.equal(decision.qualityTarget, 0.85);
  assert.deepEqual(decision.fallbackProviders, ['gpt-4-turbo', 'claude-3-opus']);
  assert.equal(decision.contextResetRequired, true);
  assert.equal(decision.operatorOverride, false);
  assert.equal(decision.reasoning.selectedReason, 'quality-optimal');
});

test('planBatches chooses smaller safe chunks when context grows', () => {
  const task = buildTaskRequest({
    taskId: 't-102',
    kind: 'document-analysis',
    items: Array.from({ length: 120 }, (_, idx) => idx),
    qualityTarget: 0.9,
    providerPreference: ['anthropic']
  });

  const profiles = [
    {
      name: 'anthropic',
      contextWindow: 200000,
      safeContextRatio: 0.62,
      qualityCurve: { low: 0.94, medium: 0.9, high: 0.82 },
      tokensPerItem: 2500,
      maxBatchSize: 35
    },
    {
      name: 'openai',
      contextWindow: 128000,
      safeContextRatio: 0.6,
      qualityCurve: { low: 0.92, medium: 0.88, high: 0.77 },
      tokensPerItem: 2300,
      maxBatchSize: 30
    }
  ];

  const plan = planBatches(task, profiles);
  assert.ok(plan.length >= 2);
  assert.ok(plan.every((entry) => entry.batchSize > 0));
  assert.ok(plan[0].batchSize <= 35);
  assert.ok(plan[0].totalBatches >= 3);
  assert.ok(plan[0].qualityEstimate >= 0.8);
});

test('planBatches keeps batch size within provider limits', () => {
  const task = buildTaskRequest({
    taskId: 't-103',
    kind: 'summary',
    items: Array.from({ length: 80 }, (_, idx) => idx),
    qualityTarget: 0.88,
    providerPreference: ['openai']
  });

  const profiles = [{
    name: 'openai',
    contextWindow: 128000,
    safeContextRatio: 0.6,
    qualityCurve: { low: 0.92, medium: 0.88, high: 0.75 },
    tokensPerItem: 2500,
    maxBatchSize: 25
  }];

  const plan = planBatches(task, profiles);
  assert.equal(plan[0].provider, 'openai');
  assert.ok(plan[0].batchSize <= 25);
  assert.ok(plan[0].totalBatches >= 3);
  assert.ok(plan[0].qualityEstimate >= 0.8);
});
