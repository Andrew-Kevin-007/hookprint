import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEDGER_EVENT_TYPES,
  createLedgerEvent,
  buildRouteLedgerEntry,
  buildDashboardSnapshot
} from '../execution-contracts.js';

test('ledger event schema validates event types and timestamps', () => {
  const event = createLedgerEvent({
    eventType: 'task-routed',
    taskId: 'task-1',
    provider: 'anthropic',
    routeId: 'route-1',
    payload: { batchCount: 4 }
  });

  assert.ok(LEDGER_EVENT_TYPES.includes(event.eventType));
  assert.equal(event.provider, 'anthropic');
  assert.equal(event.payload.batchCount, 4);
  assert.ok(event.timestamp);
});

test('route decision payload preserves route choice and fallback metadata', () => {
  const route = buildRouteLedgerEntry({
    taskId: 'task-42',
    selectedProvider: 'anthropic',
    qualityTarget: 0.9,
    confidence: 0.91,
    batchPlan: [{ provider: 'anthropic', batchSize: 25 }, { provider: 'anthropic', batchSize: 25 }],
    fallbackProvider: 'openai',
    reason: 'safe-window-routing',
    riskLevel: 'medium'
  });

  assert.equal(route.selectedProvider, 'anthropic');
  assert.equal(route.fallbackProvider, 'openai');
  assert.equal(route.reason, 'safe-window-routing');
  assert.equal(route.batchPlan.length, 2);
  assert.equal(route.qualityTarget, 0.9);
});

test('dashboard snapshot summarizes route decisions and provider health', () => {
  const snapshot = buildDashboardSnapshot({
    taskRouteDecisions: [
      buildRouteLedgerEntry({
        taskId: 'task-a',
        selectedProvider: 'anthropic',
        qualityTarget: 0.9,
        confidence: 0.92,
        batchPlan: [{ provider: 'anthropic', batchSize: 25 }],
        riskLevel: 'low'
      }),
      buildRouteLedgerEntry({
        taskId: 'task-b',
        selectedProvider: 'local',
        qualityTarget: 0.8,
        confidence: 0.74,
        batchPlan: [{ provider: 'local', batchSize: 8 }],
        riskLevel: 'high'
      })
    ],
    providerProfiles: [
      { name: 'anthropic', safeBatch: 25, qualityEstimate: 0.9, totalBatches: 2 },
      { name: 'local', safeBatch: 8, qualityEstimate: 0.75, totalBatches: 4 }
    ]
  });

  assert.equal(snapshot.summary.totalTasks, 2);
  assert.equal(snapshot.summary.highRisk, 1);
  assert.equal(snapshot.routes[0].selectedProvider, 'anthropic');
  assert.equal(snapshot.providerHealth[1].name, 'local');
});
