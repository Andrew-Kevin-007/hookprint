import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTaskRequest, planBatches, buildRouteDecision } from '../route-contracts.js';
import { executeBatch, buildPromptFromBatch } from '../executor/index.js';
import { buildEnvelopePrompt } from '../executor/envelope.js';
import { normalizeClaim, subjectsMatch, compareClaims, crossCheckBatches } from '../merge/consistency.js';
import { mergeRoute, buildMergeLedgerEvent } from '../merge/index.js';
import { appendEvent, readEvents } from '../ledger/store.js';

/* -------------------------------------------------------------------------- */
/* normalizeClaim / subjectsMatch                                             */
/* -------------------------------------------------------------------------- */

test('normalizeClaim: percent, bare ratio, and "N of M" all normalize to the same [0,1] ratio dimension and value', () => {
  const percent = normalizeClaim({ subject: 'x', value: 5, unit: 'percent', denominator: null });
  const ratio = normalizeClaim({ subject: 'x', value: 0.05, unit: 'ratio', denominator: null });
  const nOfM = normalizeClaim({ subject: 'x', value: 1, unit: 'records', denominator: 20 });

  assert.equal(percent.dimension, 'ratio');
  assert.equal(ratio.dimension, 'ratio');
  assert.equal(nOfM.dimension, 'ratio');
  assert.ok(Math.abs(percent.value - 0.05) < 1e-9);
  assert.ok(Math.abs(ratio.value - 0.05) < 1e-9);
  assert.ok(Math.abs(nOfM.value - 0.05) < 1e-9);
});

test('normalizeClaim: two absolute claims sharing a unit family compare, but distinct unit families do not', () => {
  const records = normalizeClaim({ subject: 'x', value: 250, unit: 'records' });
  const dispatches = normalizeClaim({ subject: 'x', value: 250, unit: 'dispatches' });
  assert.notEqual(records.dimension, dispatches.dimension); // different stems, deliberately not conflated -- see file header
});

test('subjectsMatch: paraphrased subjects match; unrelated subjects do not', () => {
  const a = { subject: 'dispatch records carrying a confidence value' };
  const b = { subject: 'dispatch records with a confidence value' };
  const c = { subject: 'average response latency in milliseconds' };
  assert.equal(subjectsMatch(a, b), true);
  assert.equal(subjectsMatch(a, c), false);
});

/* -------------------------------------------------------------------------- */
/* compareClaims                                                             */
/* -------------------------------------------------------------------------- */

test('compareClaims: same subject, same value expressed as percent vs bare ratio vs "N of M" -> agree', () => {
  const claimPercent = { subject: 'dispatch records with a confidence value', value: 5, unit: 'percent', denominator: null };
  const claimRatio = { subject: 'dispatch records with a confidence value', value: 0.05, unit: 'ratio', denominator: null };
  const claimNofM = { subject: 'dispatch records with a confidence value', value: 1, unit: 'records', denominator: 20, basis: 'records' };

  assert.equal(compareClaims(claimPercent, claimRatio).relation, 'agree');
  assert.equal(compareClaims(claimPercent, claimNofM).relation, 'agree');
  assert.equal(compareClaims(claimRatio, claimNofM).relation, 'agree');
});

test('compareClaims: same subject, genuinely different values -> contradict, with a delta', () => {
  const a = { subject: 'dispatch records that failed verification', value: 10, unit: 'percent', denominator: null };
  const b = { subject: 'dispatch records that failed verification', value: 60, unit: 'percent', denominator: null };
  const result = compareClaims(a, b);
  assert.equal(result.relation, 'contradict');
  assert.ok(Number.isFinite(result.delta) && result.delta > 0.15, `expected a delta above tolerance, got ${result.delta}`);
});

test('compareClaims: THE CROSS-DIMENSION CASE -- "5%" and "2 of 37" about the same subject are recognized as comparable (never "unrelated" due to dimension mismatch) and correctly judged', () => {
  const claimPercent = { subject: 'dispatch records that failed verification', value: 5, unit: 'percent', denominator: null };
  const claimNofM = { subject: 'dispatch records that failed verification', value: 2, unit: 'records', denominator: 37, basis: 'all dispatch records' };

  const normA = normalizeClaim(claimPercent);
  const normB = normalizeClaim(claimNofM);
  assert.equal(normA.dimension, 'ratio');
  assert.equal(normB.dimension, 'ratio');
  assert.ok(Math.abs(normA.value - 0.05) < 1e-9, `expected 0.05, got ${normA.value}`);
  assert.ok(Math.abs(normB.value - 2 / 37) < 1e-9, `expected ${2 / 37}, got ${normB.value}`);

  const result = compareClaims(claimPercent, claimNofM);
  assert.notEqual(result.relation, 'unrelated');
  // 0.05 vs 0.054054... is a 7.5% relative difference -- inside the 15% peer tolerance.
  assert.equal(result.relation, 'agree');
});

test('compareClaims: two claims about genuinely different subjects -> unrelated, never falsely flagged as agreement or contradiction', () => {
  const a = { subject: 'average response latency in milliseconds', value: 120, unit: 'ms', denominator: null };
  const b = { subject: 'dispatch records that failed verification', value: 5, unit: 'percent', denominator: null };
  const result = compareClaims(a, b);
  assert.equal(result.relation, 'unrelated');
  assert.equal(result.delta, null);
});

/* -------------------------------------------------------------------------- */
/* crossCheckBatches                                                         */
/* -------------------------------------------------------------------------- */

test('crossCheckBatches: contradictions, agreements, and unmatched claims are all reported, never hidden', () => {
  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      envelope: {
        answer: 'a',
        claims: [
          { subject: 'dispatch records that failed verification', value: 5, unit: 'percent', denominator: null },
          { subject: 'average response latency in milliseconds', value: 120, unit: 'ms', denominator: null }
        ]
      }
    },
    {
      provider: 'openai',
      batchIndex: 1,
      envelope: {
        answer: 'b',
        claims: [{ subject: 'dispatch records that failed verification', value: 60, unit: 'percent', denominator: null }]
      }
    }
  ];

  const result = crossCheckBatches(batchResults);
  assert.equal(result.contradictions.length, 1);
  assert.equal(result.agreements.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.equal(result.unmatched[0].claim.subject, 'average response latency in milliseconds');
});

test('crossCheckBatches: claims within the SAME batch are never compared against each other (no second peer)', () => {
  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      envelope: {
        answer: 'a',
        claims: [
          { subject: 'dispatch records that failed verification', value: 5, unit: 'percent', denominator: null },
          { subject: 'dispatch records that failed verification', value: 90, unit: 'percent', denominator: null }
        ]
      }
    }
  ];
  const result = crossCheckBatches(batchResults);
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.agreements.length, 0);
  assert.equal(result.unmatched.length, 2);
});

/* -------------------------------------------------------------------------- */
/* mergeRoute -- INCOMPLETE                                                   */
/* -------------------------------------------------------------------------- */

test('mergeRoute: a batch whose envelope fails to parse (or whose execution failed) yields INCOMPLETE, names every failed batch by provider/index, and never silently drops it', () => {
  const routeDecision = buildRouteDecision({ taskId: 'task-incomplete', primaryProvider: 'anthropic', fallbackProviders: ['openai', 'local'] });
  const goodEnvelope = { answer: 'All good.', claims: [] };

  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      outcome: { status: 'success', actualTokens: 100, latencyMs: 5, output: JSON.stringify(goodEnvelope), errorDetail: null, errorClass: null, provider: 'anthropic' }
    },
    {
      provider: 'openai',
      batchIndex: 1,
      outcome: { status: 'success', actualTokens: 80, latencyMs: 5, output: 'not json at all', errorDetail: null, errorClass: null, provider: 'openai' }
    },
    {
      provider: 'local',
      batchIndex: 2,
      outcome: { status: 'quota_exceeded', actualTokens: 0, latencyMs: 5, output: null, errorDetail: 'rate limited', errorClass: 'RateLimitError', provider: 'local' }
    }
  ];

  const result = mergeRoute(routeDecision, batchResults);

  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.failedBatches.length, 2);
  const byProvider = Object.fromEntries(result.failedBatches.map((f) => [f.provider, f]));
  assert.ok(byProvider.openai, 'expected the parse-failed openai batch to be named');
  assert.ok(byProvider.local, 'expected the execution-failed local batch to be named');
  assert.equal(byProvider.openai.batchIndex, 1);
  assert.equal(byProvider.local.batchIndex, 2);
  assert.match(byProvider.local.reason, /quota_exceeded/);

  assert.match(result.answer, /INCOMPLETE/);
  assert.match(result.answer, /openai/);
  assert.match(result.answer, /local/);
  // The one successful batch's answer must still surface, not be dropped alongside the failures.
  assert.match(result.answer, /All good\./);
});

/* -------------------------------------------------------------------------- */
/* Full integration: intake -> profile/plan -> execute -> merge              */
/* -------------------------------------------------------------------------- */

test('INTEGRATION: intake -> plan -> execute two mock-provider batches -> merge catches a planted contradiction, never silently resolving it', async () => {
  const task = buildTaskRequest({
    taskId: 'task-integration-1',
    kind: 'document-analysis',
    items: [
      { id: 'a', content: 'Dispatch log excerpt A: 2 of 37 dispatch records failed verification this week.' },
      { id: 'b', content: 'Dispatch log excerpt B: roughly 40% of dispatch records failed verification this week.' }
    ]
  });

  const providers = [
    { name: 'anthropic', tokensPerItem: 500, contextWindow: 100000, maxBatchSize: 10 },
    { name: 'openai', tokensPerItem: 500, contextWindow: 100000, maxBatchSize: 10 }
  ];

  // Step 2/4: profile + plan (existing route-contracts.js functions).
  const plan = planBatches(task, providers);
  assert.ok(plan.length >= 2, 'expected planBatches to produce a fit for both providers');

  const routeDecision = buildRouteDecision({
    taskId: task.taskId,
    primaryProvider: plan[0].provider,
    fallbackProviders: [plan[1].provider],
    batchPlan: [
      { batchIndex: 0, itemIds: ['a'], expectedTokens: 500 },
      { batchIndex: 1, itemIds: ['b'], expectedTokens: 500 }
    ],
    reasoning: { taskKind: task.kind, selectedReason: 'quality-optimal', alternativeProviders: [], rejectedReasons: {} }
  });

  // Batch A's real fact: 2 of 37 (~5.4%). Batch B's real fact, about the SAME
  // subject: a deliberately planted, genuinely different rate (~40%).
  const envelopeA = {
    answer: 'About 2 of 37 dispatch records failed verification this week.',
    claims: [
      {
        subject: 'dispatch records that failed verification',
        value: 2,
        unit: 'records',
        denominator: 37,
        basis: 'all dispatch records',
        qualifier: 'measured',
        confidence: 0.9
      }
    ]
  };
  const envelopeB = {
    answer: 'Roughly 40% of dispatch records failed verification this week.',
    claims: [
      {
        subject: 'dispatch records that failed verification',
        value: 40,
        unit: 'percent',
        denominator: null,
        basis: null,
        qualifier: 'estimated',
        confidence: 0.6
      }
    ]
  };

  let capturedPromptA = null;
  let capturedPromptB = null;

  const clientA = {
    messages: {
      create: async (req) => {
        capturedPromptA = req.messages[0].content;
        return {
          content: [{ type: 'text', text: JSON.stringify(envelopeA) }],
          usage: { input_tokens: 120, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        };
      }
    }
  };
  const clientB = {
    chat: {
      completions: {
        create: async (req) => {
          capturedPromptB = req.messages[0].content;
          return {
            choices: [{ message: { content: JSON.stringify(envelopeB) } }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
          };
        }
      }
    }
  };

  // Step 1's envelope prompt genuinely wired into execution, not decorative:
  // buildPrompt overrides executeBatch()'s default buildPromptFromBatch() call.
  const buildPrompt = (rd, batch) => buildEnvelopePrompt(buildPromptFromBatch(rd, batch), { kind: rd.reasoning.taskKind });

  // Step 5: execute two batches (fresh context, mocked providers).
  const outcomeA = await executeBatch(routeDecision, [task.items[0]], { client: clientA, providerName: 'anthropic', buildPrompt });
  const outcomeB = await executeBatch(routeDecision, [task.items[1]], { client: clientB, providerName: 'openai', buildPrompt });

  assert.equal(outcomeA.status, 'success');
  assert.equal(outcomeB.status, 'success');
  // Prove buildEnvelopePrompt actually shaped the real request, not just a standalone unit.
  assert.match(capturedPromptA, /"claims"/);
  assert.match(capturedPromptB, /"claims"/);

  // Step 6: merge.
  const mergeResult = mergeRoute(routeDecision, [
    { provider: 'anthropic', batchIndex: 0, outcome: outcomeA },
    { provider: 'openai', batchIndex: 1, outcome: outcomeB }
  ]);

  assert.equal(mergeResult.status, 'CONTRADICTIONS_FOUND');
  assert.equal(mergeResult.verification.contradictions.length, 1);
  const contradiction = mergeResult.verification.contradictions[0];
  assert.equal(contradiction.comparison.relation, 'contradict');
  assert.ok(contradiction.comparison.delta > 0.15);
  assert.equal(mergeResult.failedBatches.length, 0);
  assert.equal(mergeResult.provenance.length, 2);

  // Never silently resolved: both batches' own answers still appear, plus an explicit flag.
  assert.match(mergeResult.answer, /CONTRADICTIONS FOUND/);
  assert.match(mergeResult.answer, /2 of 37/);
  assert.match(mergeResult.answer, /40%/);

  // Log the merge outcome via the existing ledger pattern, then read it back for real.
  const dir = mkdtempSync(join(tmpdir(), 'quorum-merge-test-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  try {
    const event = buildMergeLedgerEvent(routeDecision, mergeResult);
    appendEvent(ledgerPath, event);

    const { events, malformedLines, readError } = readEvents(ledgerPath);
    assert.equal(readError, null);
    assert.equal(malformedLines.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'merge-contradiction-found');
    assert.equal(events[0].taskId, task.taskId);
    assert.equal(events[0].payload.contradictionCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
