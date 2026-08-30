import test from 'node:test';
import assert from 'node:assert/strict';

import { compareOutcome, attachOutcomeComparison, OUTCOME_ACCURATE_THRESHOLD } from '../trace/outcome.js';
import { buildRouteDecision } from '../route-contracts.js';

/* -------------------------------------------------------------------------- */
/* compareOutcome -- three direction cases                                   */
/* -------------------------------------------------------------------------- */

test('compareOutcome: predicted higher than actual, beyond tolerance -> over-predicted', () => {
  const result = compareOutcome(0.9, 0.5);
  assert.equal(result.predictedQuality, 0.9);
  assert.equal(result.actualQuality, 0.5);
  assert.ok(Math.abs(result.delta - -0.4) < 1e-9);
  assert.equal(result.direction, 'over-predicted');
  assert.equal(result.withinTolerance, false);
  assert.equal(result.accurateThreshold, OUTCOME_ACCURATE_THRESHOLD);
});

test('compareOutcome: predicted lower than actual, beyond tolerance -> under-predicted', () => {
  const result = compareOutcome(0.5, 0.9);
  assert.ok(Math.abs(result.delta - 0.4) < 1e-9);
  assert.equal(result.direction, 'under-predicted');
  assert.equal(result.withinTolerance, false);
});

test('compareOutcome: delta within the accurate threshold -> accurate, regardless of sign', () => {
  const slightlyOver = compareOutcome(0.75, 0.7); // delta = -0.05
  const slightlyUnder = compareOutcome(0.7, 0.75); // delta = 0.05
  const exact = compareOutcome(0.8, 0.8); // delta = 0

  assert.equal(slightlyOver.direction, 'accurate');
  assert.equal(slightlyOver.withinTolerance, true);
  assert.equal(slightlyUnder.direction, 'accurate');
  assert.equal(slightlyUnder.withinTolerance, true);
  assert.equal(exact.direction, 'accurate');
  assert.equal(exact.delta, 0);
});

test('compareOutcome: a delta exactly AT the threshold boundary counts as accurate (<=, not <)', () => {
  const atBoundary = compareOutcome(0.8, 0.8 - OUTCOME_ACCURATE_THRESHOLD);
  assert.ok(Math.abs(atBoundary.delta - -OUTCOME_ACCURATE_THRESHOLD) < 1e-9);
  assert.equal(atBoundary.direction, 'accurate');
  assert.equal(atBoundary.withinTolerance, true);
});

test('compareOutcome: non-finite inputs never throw and are treated as 0, not NaN', () => {
  assert.doesNotThrow(() => compareOutcome(undefined, null));
  const result = compareOutcome(undefined, null);
  assert.equal(result.predictedQuality, 0);
  assert.equal(result.actualQuality, 0);
  assert.equal(result.direction, 'accurate');
});

/* -------------------------------------------------------------------------- */
/* attachOutcomeComparison -- pure, non-mutating                             */
/* -------------------------------------------------------------------------- */

test('attachOutcomeComparison: returns a NEW object and never mutates the input routeDecision', () => {
  const routeDecision = buildRouteDecision({
    taskId: 'task-attach-1',
    primaryProvider: 'anthropic',
    reasoning: { selectedReason: 'quality-optimal', alternativeProviders: [], rejectedReasons: {} }
  });
  const frozenReasoningRef = routeDecision.reasoning;
  const comparison = compareOutcome(0.8, 0.75);

  const updated = attachOutcomeComparison(routeDecision, 0, comparison);

  assert.notEqual(updated, routeDecision, 'must return a new object, not the same reference');
  assert.notEqual(updated.reasoning, frozenReasoningRef, 'reasoning must also be a new object');
  assert.equal(routeDecision.reasoning.outcomeComparisons, undefined, 'the original routeDecision must be untouched');
  assert.deepEqual(updated.reasoning.outcomeComparisons[0], comparison);
  // Every other field must be preserved.
  assert.equal(updated.taskId, routeDecision.taskId);
  assert.equal(updated.primaryProvider, routeDecision.primaryProvider);
  assert.equal(updated.reasoning.selectedReason, 'quality-optimal');
});

test('attachOutcomeComparison: attaching a second batch index preserves the first, sparse array included', () => {
  const routeDecision = buildRouteDecision({ taskId: 'task-attach-2', primaryProvider: 'openai' });
  const cmpA = compareOutcome(0.9, 0.85);
  const cmpB = compareOutcome(0.6, 0.9);

  const afterA = attachOutcomeComparison(routeDecision, 0, cmpA);
  const afterB = attachOutcomeComparison(afterA, 2, cmpB); // deliberately skip index 1

  assert.deepEqual(afterB.reasoning.outcomeComparisons[0], cmpA);
  assert.deepEqual(afterB.reasoning.outcomeComparisons[2], cmpB);
  assert.equal(afterB.reasoning.outcomeComparisons.length, 3);
  // afterA must be untouched by building afterB.
  assert.equal(afterA.reasoning.outcomeComparisons.length, 1);
});

test('attachOutcomeComparison: rejects a missing routeDecision, a non-integer batchIndex, or a missing comparison', () => {
  const routeDecision = buildRouteDecision({ taskId: 'task-attach-3' });
  const comparison = compareOutcome(0.5, 0.5);

  assert.throws(() => attachOutcomeComparison(null, 0, comparison));
  assert.throws(() => attachOutcomeComparison(routeDecision, -1, comparison));
  assert.throws(() => attachOutcomeComparison(routeDecision, 1.5, comparison));
  assert.throws(() => attachOutcomeComparison(routeDecision, 0, null));
});
