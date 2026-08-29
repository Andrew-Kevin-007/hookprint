import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decideRoute,
  shouldRetryOnFallback,
  decideFallback,
  toDashboardEntry,
  HIGH_CONFIDENCE_TRUST_THRESHOLD,
  QUOTA_COMFORTABLE_FRACTION
} from '../dispatcher/policy.js';
import { buildDashboardSnapshot } from '../execution-contracts.js';
import { appendEvent, readEvents } from '../ledger/store.js';
import { createLedgerEvent } from '../execution-contracts.js';
import { MODEL_PROFILES } from '../provider-profiles.js';

function makeTempLedgerPath() {
  const dir = mkdtempSync(join(tmpdir(), 'baton-dispatch-policy-'));
  return { dir, path: join(dir, 'ledger.jsonl') };
}

function makeItems(count) {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, content: `content ${i}` }));
}

/** Flat accuracy history whose recency-weighted trust score sits at ~`accuracy` (uniform values, so recent*0.7 + historical*0.3 collapses back to `accuracy`). */
function flatHistory(accuracy, count = 20) {
  return Array.from({ length: count }, (_, i) => ({
    accuracy,
    timestamp: new Date(Date.now() - (count - i) * 60 * 60 * 1000).toISOString()
  }));
}

const anthropicProfile = { ...MODEL_PROFILES.anthropic };
const openaiProfile = { ...MODEL_PROFILES.openai };

test('1. a high-reputation agent prediction is approved directly, and the shortcut names the agent + trust score', () => {
  const task = { taskId: 'task-hr-1', items: makeItems(5) };
  const history = { 'agent-trusted': flatHistory(0.97) };

  const decision = decideRoute(task, {
    providerList: [anthropicProfile, openaiProfile],
    agentPredictions: [{ agentId: 'agent-trusted', provider: 'anthropic', predictedTokens: 4000, confidence: 0.95 }],
    reputationLookup: (agentId) => history[agentId] ?? []
  });

  assert.equal(decision.approved, true);
  assert.equal(decision.primaryProvider, 'anthropic');
  assert.equal(decision.reasoning.decisionPath, 'step-1-high-reputation-shortcut');
  assert.equal(decision.reasoning.triggeringAgent, 'agent-trusted');
  assert.ok(decision.reasoning.triggeringTrustScore > HIGH_CONFIDENCE_TRUST_THRESHOLD, 'reasoning must record the actual trust score that triggered the shortcut');
  assert.ok(decision.batchPlan.length > 0);
});

test('2. predicted usage comfortably under 50% of available quota is approved with an explicit warning', () => {
  const { dir, path } = makeTempLedgerPath();
  const t = { after: (fn) => fn }; // inline cleanup helper isn't available outside node:test's `t`; use try/finally instead
  try {
    // Small task -> low estimated tokens; a large totalQuota with nothing used yet -> huge remaining.
    const task = { taskId: 'task-quota-1', items: makeItems(3) };
    const providerWithQuota = { ...anthropicProfile, totalQuota: 1_000_000 };

    const decision = decideRoute(task, {
      providerList: [providerWithQuota, openaiProfile],
      agentPredictions: [], // no agent predictions at all -> step 1 cannot trigger
      ledgerPath: path
    });

    assert.equal(decision.approved, true);
    assert.equal(decision.reasoning.decisionPath, 'step-2-quota-buffer');
    assert.ok(Array.isArray(decision.reasoning.warnings));
    assert.ok(
      decision.reasoning.warnings.some((w) => /risky if burn rate changes/i.test(w)),
      `expected an explicit burn-rate warning, got ${JSON.stringify(decision.reasoning.warnings)}`
    );
    assert.ok(decision.reasoning.quota.actualFraction < QUOTA_COMFORTABLE_FRACTION);

    // Confirm the decision was actually logged to the ledger (task-routed, not overridden).
    const { events } = readEvents(path, { eventType: 'task-routed', taskId: 'task-quota-1' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.operatorOverride, false);
    assert.equal(events[0].payload.approved, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('3. two competing predictions: lower-token/higher-reputation beats higher-token/lower-reputation, and the loser is recorded with a real reason', () => {
  // Both trust scores are kept below HIGH_CONFIDENCE_TRUST_THRESHOLD (0.90) on
  // purpose, so this exercises step 3 specifically rather than short-circuiting
  // at step 1 — PRODUCT-ARCHITECTURE.md's own worked step-3 example uses a 0.95
  // trust score, which would trip step 1 first under this policy's threshold;
  // this test deliberately picks numbers that isolate step 3's own logic.
  const task = { taskId: 'task-multi-1', items: makeItems(10) };
  const history = {
    'agent-cheap-trusted': flatHistory(0.85),
    'agent-expensive-shaky': flatHistory(0.6)
  };

  const decision = decideRoute(task, {
    providerList: [anthropicProfile, openaiProfile], // no totalQuota -> step 2 can't approve -> falls through to step 3
    agentPredictions: [
      { agentId: 'agent-expensive-shaky', provider: 'openai', predictedTokens: 8000, confidence: 0.7 },
      { agentId: 'agent-cheap-trusted', provider: 'anthropic', predictedTokens: 3000, confidence: 0.8 }
    ],
    reputationLookup: (agentId) => history[agentId] ?? []
  });

  assert.equal(decision.approved, true);
  assert.equal(decision.reasoning.decisionPath, 'step-3-multi-agent-comparison');
  assert.equal(decision.primaryProvider, 'anthropic', 'the lower-token/higher-reputation agent should win despite recommending fewer raw tokens than a naive "biggest number wins" rule would need');
  assert.equal(decision.reasoning.triggeringAgent, 'agent-cheap-trusted');

  const rejected = decision.reasoning.rejectedReasons['agent-expensive-shaky'];
  assert.ok(typeof rejected === 'string' && rejected.length > 0, 'the losing alternative must appear in rejectedReasons with an actual reason string');
  assert.ok(/8000/.test(rejected) && /agent-cheap-trusted/.test(rejected), `expected the loser's reason to reference both its own tokens and the winner, got: ${rejected}`);
});

test('4. no confident agent + insufficient quota -> a structured rejection object, not a thrown error or null', () => {
  const task = { taskId: 'task-reject-1', items: makeItems(60) }; // large task -> large estimated tokens
  const history = { 'agent-unsure': flatHistory(0.65) }; // below HIGH_CONFIDENCE_TRUST_THRESHOLD

  // No ledgerPath at all -> quota is unknowable -> step 2 cannot approve.
  // Only one usable prediction -> step 3 needs >= 2 candidates, so it can't trigger either.
  const decision = decideRoute(task, {
    providerList: [anthropicProfile, openaiProfile],
    agentPredictions: [{ agentId: 'agent-unsure', provider: 'anthropic', predictedTokens: 500000, confidence: 0.65 }],
    reputationLookup: (agentId) => history[agentId] ?? []
  });

  assert.equal(decision.approved, false);
  assert.equal(typeof decision, 'object');
  assert.notEqual(decision, null);
  assert.ok(typeof decision.reason === 'string' && /No agent confident enough/i.test(decision.reason), `expected the doc's worked rejection phrasing, got: ${decision.reason}`);
  assert.ok(/0\.65/.test(decision.reason), `expected the max confidence (0.65) to appear in the reason, got: ${decision.reason}`);
  assert.ok(Array.isArray(decision.suggestions) && decision.suggestions.length > 0);
});

test('5. rate-limit/timeout failures trigger fallback selection; a bad-request failure does not blindly retry the same batch elsewhere', () => {
  const routeDecision = {
    decisionId: 'route-1',
    primaryProvider: 'anthropic',
    fallbackProviders: ['openai', 'local']
  };

  const rateLimitOutcome = { status: 'quota_exceeded', errorClass: 'RateLimitError' };
  const timeoutOutcome = { status: 'timeout', errorClass: 'APIConnectionTimeoutError' };
  const badRequestOutcome = { status: 'error', errorClass: 'BadRequestError' };
  const authOutcome = { status: 'error', errorClass: 'AuthenticationError' };

  assert.equal(shouldRetryOnFallback(rateLimitOutcome), true);
  assert.equal(shouldRetryOnFallback(timeoutOutcome), true);
  assert.equal(shouldRetryOnFallback(badRequestOutcome), false, 'a bad-request/malformed-input failure must not be treated as retriable — the same input fails identically on any provider');
  assert.equal(shouldRetryOnFallback(authOutcome), false, 'an auth failure needs operator attention, not a silent reroute');

  const rateLimitDecision = decideFallback(routeDecision, rateLimitOutcome, []);
  assert.equal(rateLimitDecision.retry, true);
  assert.equal(rateLimitDecision.nextProvider, 'openai', 'must use pickNextFallbackProvider(), not reinvent the fallback-chain walk');

  const timeoutDecision = decideFallback(routeDecision, timeoutOutcome, ['openai']);
  assert.equal(timeoutDecision.retry, true);
  assert.equal(timeoutDecision.nextProvider, 'local');

  const badRequestDecision = decideFallback(routeDecision, badRequestOutcome, []);
  assert.equal(badRequestDecision.retry, false);
  assert.equal(badRequestDecision.nextProvider, null);
  assert.ok(/same batch content would fail identically/i.test(badRequestDecision.reason));

  const authDecision = decideFallback(routeDecision, authOutcome, []);
  assert.equal(authDecision.retry, false);
  assert.equal(authDecision.nextProvider, null);
  assert.ok(/operator attention/i.test(authDecision.reason));
});

test('6. an operator override produces a decision whose ledger event is distinguishably marked as an override', () => {
  const { dir, path } = makeTempLedgerPath();
  try {
    const task = { taskId: 'task-override-1', items: makeItems(4) };

    const decision = decideRoute(task, {
      providerList: [anthropicProfile, openaiProfile],
      ledgerPath: path,
      operatorOverride: { provider: 'openai', reason: 'operator manually pinned this task to OpenAI for a scheduled Anthropic maintenance window' }
    });

    assert.equal(decision.approved, true);
    assert.equal(decision.operatorOverride, true);
    assert.equal(decision.primaryProvider, 'openai');

    const { events } = readEvents(path, { eventType: 'task-routed', taskId: 'task-override-1' });
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.operatorOverride, true, 'the override must be flagged in the ledger, not merely implied');

    // And a normal (non-override) decision on a different task must NOT carry that flag as true.
    const normalDecision = decideRoute(
      { taskId: 'task-normal-1', items: makeItems(4) },
      {
        providerList: [{ ...anthropicProfile, totalQuota: 1_000_000 }, openaiProfile],
        ledgerPath: path
      }
    );
    assert.equal(normalDecision.operatorOverride, false);
    const { events: normalEvents } = readEvents(path, { eventType: 'task-routed', taskId: 'task-normal-1' });
    assert.equal(normalEvents.length, 1);
    assert.equal(normalEvents[0].payload.operatorOverride, false, 'a normal automated decision must explicitly carry operatorOverride: false, never just omit the field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('7. every decision shape (approved / rejected / overridden) feeds into buildDashboardSnapshot() without error', () => {
  const { dir, path } = makeTempLedgerPath();
  try {
    const approvedByShortcut = decideRoute(
      { taskId: 'dash-approved-shortcut', items: makeItems(5) },
      {
        providerList: [anthropicProfile, openaiProfile],
        agentPredictions: [{ agentId: 'agent-gold', provider: 'anthropic', predictedTokens: 4000, confidence: 0.95 }],
        reputationLookup: () => flatHistory(0.98)
      }
    );

    const approvedByQuota = decideRoute(
      { taskId: 'dash-approved-quota', items: makeItems(3) },
      { providerList: [{ ...anthropicProfile, totalQuota: 1_000_000 }, openaiProfile], ledgerPath: path }
    );

    const rejected = decideRoute(
      { taskId: 'dash-rejected', items: makeItems(60) },
      {
        providerList: [anthropicProfile, openaiProfile],
        agentPredictions: [{ agentId: 'agent-unsure', provider: 'anthropic', predictedTokens: 500000, confidence: 0.5 }],
        reputationLookup: () => flatHistory(0.5)
      }
    );

    const overridden = decideRoute(
      { taskId: 'dash-override', items: makeItems(4) },
      { providerList: [anthropicProfile, openaiProfile], operatorOverride: { provider: 'anthropic', reason: 'manual pin' } }
    );

    const entries = [approvedByShortcut, approvedByQuota, rejected, overridden].map(toDashboardEntry);

    // Real integration check: buildDashboardSnapshot must not throw and must
    // produce a sensible-looking summary across all three shapes.
    const snapshot = buildDashboardSnapshot({ taskRouteDecisions: entries, providerProfiles: [anthropicProfile, openaiProfile] });

    assert.equal(snapshot.summary.totalTasks, 4);
    assert.equal(snapshot.summary.highRisk, 1, 'only the rejected decision should be high-risk on the dashboard');
    assert.equal(snapshot.routes.find((r) => r.taskId === 'dash-rejected').selectedProvider, 'none', 'a rejected task must never look like it was silently routed to a real provider');
    assert.equal(snapshot.routes.find((r) => r.taskId === 'dash-override').selectedProvider, 'anthropic');
    assert.ok(snapshot.routes.every((r) => Number.isFinite(r.confidence)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
