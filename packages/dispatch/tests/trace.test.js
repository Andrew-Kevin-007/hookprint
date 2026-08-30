import test from 'node:test';
import assert from 'node:assert/strict';

import { assembleExecutionTrace, signExecutionTrace, verifyExecutionTrace } from '../trace/index.js';
import { compareOutcome } from '../trace/outcome.js';
import { buildTaskRequest, buildRouteDecision } from '../route-contracts.js';
import { generateIdentity } from '../../sign/index.js';

const RAW_ITEM_CONTENT_A = 'Dispatch log excerpt A: 2 of 37 dispatch records failed verification this week, a string nothing else in this test produces.';
const RAW_ITEM_CONTENT_B = 'Dispatch log excerpt B: roughly 40% of dispatch records failed verification this week, another distinctive string.';

function buildFixture() {
  const task = buildTaskRequest({
    taskId: 'task-trace-1',
    kind: 'document-analysis',
    items: [
      { id: 'a', content: RAW_ITEM_CONTENT_A },
      { id: 'b', content: RAW_ITEM_CONTENT_B }
    ]
  });

  const routeDecision = buildRouteDecision({
    taskId: task.taskId,
    decisionId: 'route-trace-1',
    primaryProvider: 'anthropic',
    fallbackProviders: ['openai'],
    batchPlan: [
      { batchIndex: 0, itemIds: ['a'], expectedTokens: 500 },
      { batchIndex: 1, itemIds: ['b'], expectedTokens: 500 }
    ],
    qualityTarget: 0.85,
    reasoning: { selectedReason: 'quality-optimal', alternativeProviders: ['openai'], rejectedReasons: {} }
  });

  const batchResults = [
    { provider: 'anthropic', batchIndex: 0, outcome: { status: 'success', actualTokens: 120, latencyMs: 40 } },
    { provider: 'openai', batchIndex: 1, outcome: { status: 'success', actualTokens: 90, latencyMs: 55 } }
  ];

  const mergeResult = {
    status: 'CONTRADICTIONS_FOUND',
    verification: {
      contradictions: [{ claimA: {}, claimB: {}, comparison: {} }],
      agreements: [],
      unmatched: []
    },
    failedBatches: [],
    provenance: [],
    qualityScores: []
  };

  const outcomeComparisons = [compareOutcome(0.75, 0.68), compareOutcome(0.7, 0.72)];

  return { task, routeDecision, batchResults, mergeResult, outcomeComparisons };
}

/* -------------------------------------------------------------------------- */
/* assembleExecutionTrace -- determinism and required assembledAt            */
/* -------------------------------------------------------------------------- */

test('assembleExecutionTrace: requires assembledAt and never reads the wall clock itself', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();

  assert.throws(() =>
    assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons })
  , /assembledAt/);
});

test('assembleExecutionTrace: is deterministic -- identical inputs (including assembledAt) produce a deep-equal trace on every call', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();
  const assembledAt = '2026-08-29T00:00:00.000Z';

  const traceA = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt });
  const traceB = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt });

  assert.deepEqual(traceA, traceB);
  assert.equal(traceA.assembledAt, assembledAt);
  assert.equal(traceA.traceId, `trace-${task.taskId}-${routeDecision.decisionId}`);
});

test('assembleExecutionTrace: execution/merge summaries are computed correctly from real inputs', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();
  const trace = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt: '2026-08-29T00:00:00.000Z' });

  assert.equal(trace.execution.batchCount, 2);
  assert.equal(trace.execution.successCount, 2);
  assert.equal(trace.execution.failureCount, 0);
  assert.equal(trace.execution.totalActualTokens, 210);
  assert.equal(trace.execution.totalLatencyMs, 95);

  assert.equal(trace.merge.status, 'CONTRADICTIONS_FOUND');
  assert.equal(trace.merge.contradictionCount, 1);
  assert.equal(trace.merge.agreementCount, 0);
  assert.equal(trace.merge.unmatchedCount, 0);

  assert.equal(trace.task.itemCount, 2);
  assert.equal(trace.outcomeComparisons.length, 2);
});

test('assembleExecutionTrace: never includes full raw item/document content -- only a task SUMMARY', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();
  const trace = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt: '2026-08-29T00:00:00.000Z' });

  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes(RAW_ITEM_CONTENT_A), 'raw item A content must never appear in the trace');
  assert.ok(!serialized.includes(RAW_ITEM_CONTENT_B), 'raw item B content must never appear in the trace');
  assert.ok(!Object.prototype.hasOwnProperty.call(trace.task, 'items'), 'trace.task must be a summary, not the full task object');
});

/* -------------------------------------------------------------------------- */
/* signExecutionTrace / verifyExecutionTrace -- round trip + tamper detection */
/* -------------------------------------------------------------------------- */

test('signExecutionTrace / verifyExecutionTrace: an untampered signed trace verifies true', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();
  const trace = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt: '2026-08-29T00:00:00.000Z' });

  const identity = generateIdentity();
  const signed = signExecutionTrace(trace, identity.privateKey, identity.publicKey);

  assert.equal(typeof signed.attestation.signature, 'string');
  assert.equal(signed.attestation.publicKey, identity.publicKey);
  assert.equal(verifyExecutionTrace(signed), true);
});

test('verifyExecutionTrace: tampering merge.contradictionCount flips verification to false', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();
  const trace = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt: '2026-08-29T00:00:00.000Z' });
  const identity = generateIdentity();
  const signed = signExecutionTrace(trace, identity.privateKey, identity.publicKey);

  assert.equal(verifyExecutionTrace(signed), true);

  const tampered = { ...signed, trace: { ...signed.trace, merge: { ...signed.trace.merge, contradictionCount: 999 } } };
  assert.equal(verifyExecutionTrace(tampered), false);
});

test('verifyExecutionTrace: tampering routeDecision.primaryProvider (a DIFFERENT field) also flips verification to false', () => {
  const { task, routeDecision, batchResults, mergeResult, outcomeComparisons } = buildFixture();
  const trace = assembleExecutionTrace({ task, routeDecision, batchResults, mergeResult, outcomeComparisons, assembledAt: '2026-08-29T00:00:00.000Z' });
  const identity = generateIdentity();
  const signed = signExecutionTrace(trace, identity.privateKey, identity.publicKey);

  const tampered = {
    ...signed,
    trace: { ...signed.trace, routeDecision: { ...signed.trace.routeDecision, primaryProvider: 'openai' } }
  };
  assert.equal(verifyExecutionTrace(tampered), false);
});

test('verifyExecutionTrace: never throws on a malformed signedTrace, and returns false rather than crashing', () => {
  assert.doesNotThrow(() => verifyExecutionTrace(null));
  assert.equal(verifyExecutionTrace(null), false);
  assert.equal(verifyExecutionTrace({}), false);
  assert.equal(verifyExecutionTrace({ trace: {}, attestation: null }), false);
  assert.equal(verifyExecutionTrace({ trace: {}, attestation: { signature: 'not-base64-!!', publicKey: 'also-bad' } }), false);
});
