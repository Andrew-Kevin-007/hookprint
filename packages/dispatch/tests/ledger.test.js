import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLedgerEvent } from '../execution-contracts.js';
import { appendEvent, readEvents, computePoolState } from '../ledger/store.js';
import {
  recordPrediction,
  recordOutcome,
  computeAccuracy,
  computeTrustScore,
  assignCredibilityTier,
  buildReputationSnapshot,
  getAgentTrustScore,
  resetAgentIdentities
} from '../ledger/reputation.js';
import { verifyBundle } from '../../sign/index.js';

function makeTempLedgerPath() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-dispatch-ledger-'));
  return { dir, path: join(dir, 'ledger.jsonl') };
}

test('append + read round-trip preserves event data exactly', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const event = createLedgerEvent({
    eventType: 'task-completed',
    taskId: 'task-1',
    provider: 'anthropic',
    payload: { actualTokens: 123, predictedTokens: 100 }
  });

  appendEvent(path, event);
  const { events, malformedLines, readError } = readEvents(path);

  assert.equal(readError, null);
  assert.equal(malformedLines.length, 0);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], event);
});

test('readEvents applies since/eventType/taskId filters', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  appendEvent(path, createLedgerEvent({ eventType: 'task-created', taskId: 'a', payload: {}, timestamp: '2026-08-01T00:00:00.000Z' }));
  appendEvent(path, createLedgerEvent({ eventType: 'task-completed', taskId: 'a', payload: {}, timestamp: '2026-08-10T00:00:00.000Z' }));
  appendEvent(path, createLedgerEvent({ eventType: 'task-completed', taskId: 'b', payload: {}, timestamp: '2026-08-20T00:00:00.000Z' }));

  assert.equal(readEvents(path, { eventType: 'task-completed' }).events.length, 2);
  assert.equal(readEvents(path, { taskId: 'a' }).events.length, 2);
  assert.equal(readEvents(path, { since: '2026-08-05T00:00:00.000Z' }).events.length, 2);
  assert.equal(readEvents(path, { eventType: 'task-completed', taskId: 'a' }).events.length, 1);
});

test('a corrupted/partial last line does not crash readEvents and does not lose the events before it', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const event1 = createLedgerEvent({ eventType: 'task-created', taskId: 'task-1', payload: {} });
  const event2 = createLedgerEvent({ eventType: 'task-completed', taskId: 'task-1', payload: { actualTokens: 50 } });
  appendEvent(path, event1);
  appendEvent(path, event2);

  // Simulate a crash mid-append: a truncated, unparseable trailing line, no newline.
  appendFileSync(path, '{"eventType":"task-completed","taskId":"task-1","payload":{"actualTok');

  assert.doesNotThrow(() => readEvents(path));
  const { events, malformedLines, readError } = readEvents(path);

  assert.equal(readError, null);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], event1);
  assert.deepEqual(events[1], event2);
  assert.equal(malformedLines.length, 1);
  assert.equal(malformedLines[0].lineNumber, 3);
});

test('computePoolState derives usedToday/remaining/burnRate by replaying task-completed/task-failed events for one provider', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const now = new Date('2026-08-29T12:00:00.000Z');
  const t0 = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  const t1 = new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString();

  appendEvent(path, createLedgerEvent({ eventType: 'task-completed', taskId: 'a', provider: 'anthropic', payload: { actualTokens: 1000 }, timestamp: t0 }));
  appendEvent(path, createLedgerEvent({ eventType: 'task-completed', taskId: 'b', provider: 'anthropic', payload: { actualTokens: 2000 }, timestamp: t1 }));
  appendEvent(path, createLedgerEvent({ eventType: 'task-failed', taskId: 'c', provider: 'anthropic', payload: { actualTokens: 0 }, timestamp: now.toISOString() }));
  appendEvent(path, createLedgerEvent({ eventType: 'task-completed', taskId: 'd', provider: 'openai', payload: { actualTokens: 5000 }, timestamp: now.toISOString() }));

  const state = computePoolState(path, 'anthropic', { totalQuota: 10000, now });

  assert.equal(state.readError, null);
  assert.equal(state.usedToday, 3000); // only anthropic's 1000 + 2000; openai and the 0-token failure don't count toward this
  assert.equal(state.remaining, 7000);
  assert.equal(state.eventCount, 3);
  assert.ok(state.burnRatePerHour > 0);
  assert.equal(state.updateSource, 'local_ledger');
});

test('computeAccuracy matches the doc worked example: predicted 3600, actual 3450 -> accuracy ~0.958', () => {
  const acc = computeAccuracy(3600, 3450);
  assert.ok(Math.abs(acc - 0.958) < 0.001, `expected ~0.958, got ${acc}`);
});

test('computeTrustScore uses the recency-weighted formula (not exponential decay): 90% accuracy over 60 predictions scores HIGH', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    accuracy: 0.9,
    timestamp: new Date(Date.now() - (60 - i) * 60 * 60 * 1000).toISOString()
  }));

  const trust = computeTrustScore(history);
  assert.equal(typeof trust, 'number');
  // recency-weighted: mean(last 20)*0.7 + overall*0.3 = 0.9*0.7 + 0.9*0.3 = 0.9
  assert.ok(trust > 0.85, `expected a high trust score under the recency-weighted formula, got ${trust}`);

  // This is the assertion that would FAIL under the doc's other formula:
  // (accuracy/100)^predictions_made -> 0.9^60 ~= 0.00178. A real trust score
  // must be nowhere near that for a consistently-accurate agent.
  const exponentialFormulaResult = Math.pow(0.9, 60);
  assert.ok(trust > exponentialFormulaResult * 100, 'this test would fail under the exponential-decay formula');
});

test('assignCredibilityTier matches documented boundaries, including diamond requiring BOTH >97% accuracy AND >100 predictions', () => {
  assert.equal(assignCredibilityTier(59.9, 10), 'red');
  assert.equal(assignCredibilityTier(60, 10), 'yellow');
  assert.equal(assignCredibilityTier(74.9, 10), 'yellow');
  assert.equal(assignCredibilityTier(75, 10), 'blue');
  assert.equal(assignCredibilityTier(84.9, 10), 'blue');
  assert.equal(assignCredibilityTier(85, 10), 'green');
  assert.equal(assignCredibilityTier(92, 10), 'green');
  assert.equal(assignCredibilityTier(92.1, 10), 'gold');
  assert.equal(assignCredibilityTier(97, 200), 'gold', 'exactly 97% (not >97) must not get diamond even with enough predictions');
  assert.equal(assignCredibilityTier(98, 50), 'gold', '98% accuracy with only 50 predictions must NOT get diamond');
  assert.equal(assignCredibilityTier(98, 150), 'diamond', '>97% accuracy AND >100 predictions gets diamond');
});

test('decay: a stale agent gets a visibly less confident result than a fresh agent with the same accuracy history', () => {
  const now = new Date('2026-08-29T12:00:00.000Z');
  const accuracyValues = Array.from({ length: 10 }, () => 0.94); // gold territory (>92%) if fresh

  const freshHistory = accuracyValues.map((accuracy, i) => ({
    accuracy,
    timestamp: new Date(now.getTime() - (10 - i) * 60 * 60 * 1000).toISOString() // most recent: 1h ago
  }));
  const staleHistory = accuracyValues.map((accuracy, i) => ({
    accuracy,
    timestamp: new Date(now.getTime() - (30 - i) * 24 * 60 * 60 * 1000).toISOString() // most recent: 21 days ago
  }));

  const freshSnapshot = buildReputationSnapshot('agent-fresh', freshHistory, { now });
  const staleSnapshot = buildReputationSnapshot('agent-stale', staleHistory, { now });

  assert.equal(freshSnapshot.stale, false);
  assert.equal(freshSnapshot.confidence, 'normal');
  assert.equal(freshSnapshot.credibilityTier, 'gold');

  assert.equal(staleSnapshot.stale, true);
  assert.equal(staleSnapshot.confidence, 'reduced');
  assert.equal(staleSnapshot.credibilityTier, 'green', 'a stale agent is capped one tier below what raw accuracy would assign');

  assert.notEqual(freshSnapshot.credibilityTier, staleSnapshot.credibilityTier);
  // Same raw accuracy history -> same numeric trust score. The decay signal
  // shows up in tier/confidence, per this module's documented "cap the
  // tier" choice — it must never be silently invisible.
  assert.equal(freshSnapshot.trustScore, staleSnapshot.trustScore);
});

test('a missing or unreadable ledger produces an explicit low-confidence marker, never a bare misleading number', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Never written to — brand new / no history yet.
  const missing = getAgentTrustScore(path, 'agent-never-seen');
  assert.equal(typeof missing, 'object');
  assert.equal(missing.trustScore, null);
  assert.equal(missing.confidence, 'none');

  // Exists but is a directory, not a file — genuinely unreadable.
  const dirAsLedgerPath = join(dir, 'a-directory-not-a-file');
  mkdirSync(dirAsLedgerPath);
  const unreadable = getAgentTrustScore(dirAsLedgerPath, 'agent-x');
  assert.equal(typeof unreadable, 'object');
  assert.equal(unreadable.trustScore, null);
  assert.equal(unreadable.confidence, 'none');
  assert.equal(unreadable.reason, 'ledger-unreadable');

  // The bare function contract directly: never a number for empty/invalid input.
  assert.notEqual(typeof computeTrustScore([]), 'number');
  assert.notEqual(typeof computeTrustScore(null), 'number');
});

test('a prediction and its outcome round-trip through signing; tampering a field breaks verification', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    resetAgentIdentities();
  });

  const { predictionId, signedBundle: predSigned } = recordPrediction({
    ledgerPath: path,
    agentId: 'agent-sign-1',
    taskId: 'task-sign-1',
    predictedTokens: 3600,
    confidence: 0.92
  });

  assert.equal(verifyBundle(predSigned.bundle, predSigned.signature, predSigned.publicKey), true);

  const { signedBundle: outcomeSigned, accuracy } = recordOutcome({
    ledgerPath: path,
    agentId: 'agent-sign-1',
    taskId: 'task-sign-1',
    predictionId,
    actualTokens: 3450
  });

  assert.equal(verifyBundle(outcomeSigned.bundle, outcomeSigned.signature, outcomeSigned.publicKey), true);
  assert.ok(Math.abs(accuracy - 0.958) < 0.001);

  // Tamper one field post-hoc — reuses the exact pattern from packages/sign/tests/sign.test.js.
  const tampered = { ...outcomeSigned.bundle, actualTokens: 999999 };
  assert.equal(verifyBundle(tampered, outcomeSigned.signature, outcomeSigned.publicKey), false);

  // Both events actually landed in the ledger.
  const { events } = readEvents(path, { taskId: 'task-sign-1' });
  assert.equal(events.length, 2);
  assert.equal(events[0].eventType, 'prediction-recorded');
  assert.equal(events[1].eventType, 'reputation-updated');
});

test('recordOutcome fails closed with a clear error when predictionId does not match any recorded prediction', (t) => {
  const { dir, path } = makeTempLedgerPath();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    resetAgentIdentities();
  });

  assert.throws(
    () =>
      recordOutcome({
        ledgerPath: path,
        agentId: 'agent-sign-2',
        taskId: 'task-sign-2',
        predictionId: 'pred-does-not-exist',
        actualTokens: 100
      }),
    /no prediction found in ledger/
  );
});
