import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTaskRequest, planBatches, buildRouteDecision, estimateProviderFit } from '../route-contracts.js';
import { executeBatch, buildPromptFromBatch } from '../executor/index.js';
import { buildEnvelopePrompt, parseEnvelope } from '../executor/envelope.js';
import { crossCheckBatches } from '../merge/consistency.js';
import { mergeRoute } from '../merge/index.js';
import { appendEvent, readEvents } from '../ledger/store.js';
import {
  scoreDeterministic,
  scoreConsistency,
  scoreBatch,
  buildQualityScoreEvent,
  DETERMINISTIC_WEIGHT,
  CONSISTENCY_WEIGHT
} from '../quality/score.js';

/* -------------------------------------------------------------------------- */
/* scoreDeterministic                                                        */
/* -------------------------------------------------------------------------- */

test('scoreDeterministic: a fully valid envelope with grounded claims scores high', () => {
  const batch = [{ id: 'a', content: 'Dispatch log: 2 of 37 dispatch records failed verification this week.' }];
  const parseResult = parseEnvelope(
    JSON.stringify({
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
    })
  );
  assert.equal(parseResult.valid, true);

  const result = scoreDeterministic(parseResult, batch, null);
  assert.ok(result.score > 0.85, `expected a high deterministic score, got ${result.score}`);
  assert.ok(result.reasons.some((r) => r.includes('claims_grounded:1/1')));
});

test('scoreDeterministic: an envelope whose claims reference nothing in the input scores measurably lower (grounding fires)', () => {
  const batch = [{ id: 'a', content: 'Dispatch log: 2 of 37 dispatch records failed verification this week.' }];

  const grounded = parseEnvelope(
    JSON.stringify({
      answer: 'About 2 of 37 dispatch records failed verification this week.',
      claims: [{ subject: 'dispatch records that failed verification', value: 2, unit: 'records', denominator: 37 }]
    })
  );
  const ungrounded = parseEnvelope(
    JSON.stringify({
      answer: 'The moon landing involved 400000 engineers.',
      claims: [{ subject: 'engineers on the Apollo program', value: 400000, unit: 'people', denominator: null }]
    })
  );

  const groundedScore = scoreDeterministic(grounded, batch, null).score;
  const ungroundedScore = scoreDeterministic(ungrounded, batch, null).score;

  assert.ok(
    ungroundedScore < groundedScore,
    `expected ungrounded (${ungroundedScore}) < grounded (${groundedScore})`
  );
  const ungroundedResult = scoreDeterministic(ungrounded, batch, null);
  assert.ok(ungroundedResult.reasons.some((r) => r.includes('claims_grounded:0/1')));
});

test('scoreDeterministic: a batch with legitimately zero quantifiable content and zero claims is NOT penalized', () => {
  const batch = [{ id: 'a', content: 'The quick brown fox jumps over the lazy dog repeatedly, with no numbers at all.' }];
  const parseResult = parseEnvelope(JSON.stringify({ answer: 'A story about a fox and a dog.', claims: [] }));

  const result = scoreDeterministic(parseResult, batch, null);
  assert.equal(result.score, 1, `expected full credit, got ${result.score} (reasons: ${result.reasons.join('; ')})`);
  assert.ok(result.reasons.includes('zero_claims_expected_input_has_no_digits'));
});

test('scoreDeterministic: zero claims against input that DOES contain quantifiable content is penalized', () => {
  const batch = [{ id: 'a', content: 'Dispatch log: 2 of 37 dispatch records failed verification this week.' }];
  const parseResult = parseEnvelope(JSON.stringify({ answer: 'Some records failed.', claims: [] }));

  const result = scoreDeterministic(parseResult, batch, null);
  assert.ok(result.score < 1, `expected a penalized score, got ${result.score}`);
  assert.ok(result.reasons.includes('zero_claims_but_input_contains_quantifiable_content'));
});

test('scoreDeterministic: an invalid parseEnvelope() result scores 0 without re-deriving validity', () => {
  const failedParse = parseEnvelope('not json at all');
  assert.equal(failedParse.valid, false);
  const result = scoreDeterministic(failedParse, null, null);
  assert.equal(result.score, 0);
  assert.deepEqual(result.reasons, ['envelope_invalid']);
});

/* -------------------------------------------------------------------------- */
/* scoreConsistency                                                          */
/* -------------------------------------------------------------------------- */

test('scoreConsistency: a claim in contradictions drags the score down', () => {
  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      envelope: { answer: 'a', claims: [{ subject: 'dispatch records that failed verification', value: 5, unit: 'percent' }] }
    },
    {
      provider: 'openai',
      batchIndex: 1,
      envelope: { answer: 'b', claims: [{ subject: 'dispatch records that failed verification', value: 60, unit: 'percent' }] }
    }
  ];
  const verification = crossCheckBatches(batchResults);
  assert.equal(verification.contradictions.length, 1);

  const result = scoreConsistency(0, 'anthropic', verification);
  assert.equal(result.score, 0, 'a single contradicted claim with nothing else comparable scores 0');
});

test('scoreConsistency: a claim in agreements does not drag the score down', () => {
  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      envelope: { answer: 'a', claims: [{ subject: 'dispatch records that failed verification', value: 5, unit: 'percent' }] }
    },
    {
      provider: 'openai',
      batchIndex: 1,
      envelope: { answer: 'b', claims: [{ subject: 'dispatch records that failed verification', value: 5.2, unit: 'percent' }] }
    }
  ];
  const verification = crossCheckBatches(batchResults);
  assert.equal(verification.agreements.length, 1);

  const result = scoreConsistency(0, 'anthropic', verification);
  assert.equal(result.score, 1);
});

test('scoreConsistency: a claim in unmatched is NEUTRAL -- no penalty, no credit, provably no effect on the ratio', () => {
  // Baseline: one agreed claim only.
  const baselineResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      envelope: { answer: 'a', claims: [{ subject: 'dispatch records that failed verification', value: 5, unit: 'percent' }] }
    },
    {
      provider: 'openai',
      batchIndex: 1,
      envelope: { answer: 'b', claims: [{ subject: 'dispatch records that failed verification', value: 5.2, unit: 'percent' }] }
    }
  ];
  const baselineVerification = crossCheckBatches(baselineResults);
  const baselineScore = scoreConsistency(0, 'anthropic', baselineVerification).score;

  // Same, PLUS an extra unrelated (therefore unmatched) claim on batch 0.
  const withUnmatchedResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      envelope: {
        answer: 'a',
        claims: [
          { subject: 'dispatch records that failed verification', value: 5, unit: 'percent' },
          { subject: 'average response latency in milliseconds', value: 120, unit: 'ms' }
        ]
      }
    },
    {
      provider: 'openai',
      batchIndex: 1,
      envelope: { answer: 'b', claims: [{ subject: 'dispatch records that failed verification', value: 5.2, unit: 'percent' }] }
    }
  ];
  const withUnmatchedVerification = crossCheckBatches(withUnmatchedResults);
  assert.equal(withUnmatchedVerification.unmatched.length, 1, 'expected the latency claim to be unmatched');

  const scoreWithUnmatched = scoreConsistency(0, 'anthropic', withUnmatchedVerification).score;

  assert.equal(
    scoreWithUnmatched,
    baselineScore,
    'an unmatched claim must have exactly zero effect on batch 0\'s consistency score'
  );
  assert.equal(scoreWithUnmatched, 1);
});

test('scoreConsistency: a batch with no comparable claims at all (no claims, or nothing but unmatched) defaults to neutral score 1', () => {
  const emptyVerification = { contradictions: [], agreements: [], unmatched: [] };
  assert.equal(scoreConsistency(0, 'anthropic', emptyVerification).score, 1);

  const onlyUnmatchedVerification = {
    contradictions: [],
    agreements: [],
    unmatched: [{ provider: 'anthropic', batchIndex: 0, claim: { subject: 'x', value: 1, unit: 'y' } }]
  };
  assert.equal(scoreConsistency(0, 'anthropic', onlyUnmatchedVerification).score, 1);
});

/* -------------------------------------------------------------------------- */
/* scoreBatch -- combined arithmetic                                         */
/* -------------------------------------------------------------------------- */

test('scoreBatch: combinedScore is a real weighted combination of the two halves, not a placeholder', () => {
  const batch = [{ id: 'a', content: 'Dispatch log: 2 of 37 dispatch records failed verification this week.' }];
  const parseResult = parseEnvelope(
    JSON.stringify({
      answer: 'About 2 of 37 dispatch records failed verification this week.',
      claims: [{ subject: 'dispatch records that failed verification', value: 2, unit: 'records', denominator: 37 }]
    })
  );

  const verification = {
    contradictions: [
      {
        claimA: { provider: 'anthropic', batchIndex: 0, claim: parseResult.envelope.claims[0] },
        claimB: { provider: 'openai', batchIndex: 1, claim: { subject: 'dispatch records that failed verification', value: 90, unit: 'percent' } },
        comparison: { relation: 'contradict', delta: 0.8, reason: 'planted' }
      }
    ],
    agreements: [],
    unmatched: []
  };

  const result = scoreBatch(parseResult, batch, null, 0, 'anthropic', verification);

  const det = scoreDeterministic(parseResult, batch, null);
  const cons = scoreConsistency(0, 'anthropic', verification);

  assert.equal(result.deterministicScore, det.score);
  assert.equal(result.consistencyScore, cons.score);
  assert.equal(cons.score, 0, 'the sole claim contradicted -- consistency should be exactly 0');
  assert.equal(result.weights.deterministic, DETERMINISTIC_WEIGHT);
  assert.equal(result.weights.consistency, CONSISTENCY_WEIGHT);

  const expectedCombined = DETERMINISTIC_WEIGHT * det.score + CONSISTENCY_WEIGHT * cons.score;
  assert.ok(
    Math.abs(result.combinedScore - expectedCombined) < 1e-12,
    `expected exact weighted sum ${expectedCombined}, got ${result.combinedScore}`
  );
  // Sanity: since consistency is 0 here, combinedScore must be strictly less
  // than deterministicScore alone (proves consistency actually pulls the
  // number down rather than being ignored).
  assert.ok(result.combinedScore < det.score);
});

/* -------------------------------------------------------------------------- */
/* buildQualityScoreEvent -- ledger round-trip                              */
/* -------------------------------------------------------------------------- */

test('buildQualityScoreEvent: produces a ledger-event-shaped object that appendEvent()/readEvents() round-trip without error', () => {
  const scoreResult = {
    combinedScore: 0.7125,
    deterministicScore: 0.9,
    consistencyScore: 0.6,
    weights: { deterministic: DETERMINISTIC_WEIGHT, consistency: CONSISTENCY_WEIGHT },
    reasons: ['claims_present', 'answer_not_truncated']
  };

  const event = buildQualityScoreEvent({
    taskId: 'task-quality-1',
    provider: 'anthropic',
    routeId: 'route-quality-1',
    batchIndex: 0,
    contextRatio: 0.42,
    scoreResult
  });

  assert.equal(event.eventType, 'batch-quality-scored');
  assert.equal(event.taskId, 'task-quality-1');
  assert.equal(event.provider, 'anthropic');
  assert.equal(event.routeId, 'route-quality-1');
  assert.equal(event.payload.contextRatio, 0.42);
  assert.equal(event.payload.combinedScore, 0.7125);

  const dir = mkdtempSync(join(tmpdir(), 'quorum-quality-score-test-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  try {
    appendEvent(ledgerPath, event);
    const { events, malformedLines, readError } = readEvents(ledgerPath);
    assert.equal(readError, null);
    assert.equal(malformedLines.length, 0);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, event.payload);
    assert.equal(events[0].eventType, 'batch-quality-scored');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* Integration: mergeRoute() wires scoring + ledger end to end               */
/* -------------------------------------------------------------------------- */

test('INTEGRATION: mergeRoute() on two mock batches produces one qualityScores entry per batch with a real contextRatio/combinedScore, and appends a readable batch-quality-scored ledger event per batch', async () => {
  const task = buildTaskRequest({
    taskId: 'task-quality-integration-1',
    kind: 'document-analysis',
    items: [
      { id: 'a', content: 'Dispatch log excerpt A: 2 of 37 dispatch records failed verification this week.' },
      { id: 'b', content: 'Dispatch log excerpt B: roughly 40% of dispatch records failed verification this week.' }
    ]
  });

  const providerA = { name: 'anthropic', tokensPerItem: 500, contextWindow: 100000, maxBatchSize: 10 };
  const providerB = { name: 'openai', tokensPerItem: 500, contextWindow: 100000, maxBatchSize: 10 };
  const providers = [providerA, providerB];

  const plan = planBatches(task, providers);
  assert.ok(plan.length >= 2);

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

  const clientA = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify(envelopeA) }],
        usage: { input_tokens: 120, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      })
    }
  };
  const clientB = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(envelopeB) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
        })
      }
    }
  };

  const buildPrompt = (rd, batch) => buildEnvelopePrompt(buildPromptFromBatch(rd, batch), { kind: rd.reasoning.taskKind });

  const outcomeA = await executeBatch(routeDecision, [task.items[0]], { client: clientA, providerName: 'anthropic', buildPrompt });
  const outcomeB = await executeBatch(routeDecision, [task.items[1]], { client: clientB, providerName: 'openai', buildPrompt });
  assert.equal(outcomeA.status, 'success');
  assert.equal(outcomeB.status, 'success');

  const contextRatioA = estimateProviderFit(task, providerA).contextRatio;
  const contextRatioB = estimateProviderFit(task, providerB).contextRatio;
  assert.ok(Number.isFinite(contextRatioA) && contextRatioA > 0);
  assert.ok(Number.isFinite(contextRatioB) && contextRatioB > 0);

  const dir = mkdtempSync(join(tmpdir(), 'quorum-quality-merge-test-'));
  const ledgerPath = join(dir, 'ledger.jsonl');
  try {
    const mergeResult = mergeRoute(
      routeDecision,
      [
        { provider: 'anthropic', batchIndex: 0, outcome: outcomeA, batch: [task.items[0]], contextRatio: contextRatioA },
        { provider: 'openai', batchIndex: 1, outcome: outcomeB, batch: [task.items[1]], contextRatio: contextRatioB }
      ],
      { ledgerPath }
    );

    // The pre-existing merge behaviour must be untouched.
    assert.equal(mergeResult.status, 'CONTRADICTIONS_FOUND');
    assert.equal(mergeResult.failedBatches.length, 0);

    // The new additive field.
    assert.equal(mergeResult.qualityScores.length, 2);
    for (const qs of mergeResult.qualityScores) {
      assert.ok(Number.isFinite(qs.contextRatio) && qs.contextRatio > 0, `expected a real contextRatio, got ${qs.contextRatio}`);
      assert.ok(Number.isFinite(qs.combinedScore) && qs.combinedScore >= 0 && qs.combinedScore <= 1);
      assert.ok(Number.isFinite(qs.deterministicScore));
      assert.ok(Number.isFinite(qs.consistencyScore));
    }

    // Both batches' single claim contradicted the other's -- consistency
    // should be 0 for both, dragging combinedScore below the deterministic
    // half alone.
    const byProvider = Object.fromEntries(mergeResult.qualityScores.map((qs) => [qs.provider, qs]));
    assert.equal(byProvider.anthropic.consistencyScore, 0);
    assert.equal(byProvider.openai.consistencyScore, 0);

    // The ledger actually received one real, readable event per batch.
    const { events, malformedLines, readError } = readEvents(ledgerPath, { eventType: 'batch-quality-scored' });
    assert.equal(readError, null);
    assert.equal(malformedLines.length, 0);
    assert.equal(events.length, 2);
    for (const event of events) {
      assert.equal(event.eventType, 'batch-quality-scored');
      assert.equal(event.taskId, task.taskId);
      assert.ok(Number.isFinite(event.payload.contextRatio) && event.payload.contextRatio > 0);
      assert.ok(Number.isFinite(event.payload.combinedScore));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------------------- */
/* buildQualityScoreEvent / mergeRoute -- additive workloadType field       */
/* -------------------------------------------------------------------------- */

test('buildQualityScoreEvent: workloadType is additive -- present and correct when supplied, absent entirely (not null) when omitted', () => {
  const scoreResult = {
    combinedScore: 0.5,
    deterministicScore: 0.5,
    consistencyScore: 0.5,
    weights: { deterministic: DETERMINISTIC_WEIGHT, consistency: CONSISTENCY_WEIGHT },
    reasons: ['fixture']
  };

  const withType = buildQualityScoreEvent({ taskId: 't', provider: 'anthropic', routeId: null, batchIndex: 0, contextRatio: 0.4, scoreResult, workloadType: 'code_analysis' });
  assert.equal(withType.payload.workloadType, 'code_analysis');

  const withoutType = buildQualityScoreEvent({ taskId: 't', provider: 'anthropic', routeId: null, batchIndex: 0, contextRatio: 0.4, scoreResult });
  assert.ok(!('workloadType' in withoutType.payload), 'omitting workloadType must leave the payload with no such key at all');

  const explicitlyNull = buildQualityScoreEvent({ taskId: 't', provider: 'anthropic', routeId: null, batchIndex: 0, contextRatio: 0.4, scoreResult, workloadType: null });
  assert.ok(!('workloadType' in explicitlyNull.payload), 'an explicit null must behave the same as omitting it -- no key added');

  // Every OTHER field must be identical whether or not workloadType was given.
  const { workloadType: _omit, ...restWithType } = withType.payload;
  assert.deepEqual(restWithType, withoutType.payload);
});

test('mergeRoute(): options.workloadType produces a batch-quality-scored ledger event whose payload carries workloadType with the right value; omitting it produces an event with no such field, exactly matching the pre-change shape', () => {
  const routeDecision = buildRouteDecision({ taskId: 'task-workload-type', primaryProvider: 'anthropic' });
  const goodEnvelope = { answer: 'All good, nothing quantified here.', claims: [] };

  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      outcome: { status: 'success', actualTokens: 10, latencyMs: 1, output: JSON.stringify(goodEnvelope), errorDetail: null, errorClass: null, provider: 'anthropic' }
    }
  ];

  const dir = mkdtempSync(join(tmpdir(), 'quorum-merge-workload-type-test-'));
  try {
    const withTypePath = join(dir, 'with-type.jsonl');
    mergeRoute(routeDecision, batchResults, { ledgerPath: withTypePath, workloadType: 'code_analysis' });
    const withTypeEvents = readEvents(withTypePath, { eventType: 'batch-quality-scored' }).events;
    assert.equal(withTypeEvents.length, 1);
    assert.equal(withTypeEvents[0].payload.workloadType, 'code_analysis');

    // Also accepts the whole classifyWorkload() result object, reading .workloadType from it.
    const viaClassificationPath = join(dir, 'via-classification.jsonl');
    mergeRoute(routeDecision, batchResults, { ledgerPath: viaClassificationPath, workloadClassification: { workloadType: 'reasoning', confidence: 0.7 } });
    const viaClassificationEvents = readEvents(viaClassificationPath, { eventType: 'batch-quality-scored' }).events;
    assert.equal(viaClassificationEvents[0].payload.workloadType, 'reasoning');

    const withoutTypePath = join(dir, 'without-type.jsonl');
    mergeRoute(routeDecision, batchResults, { ledgerPath: withoutTypePath });
    const withoutTypeEvents = readEvents(withoutTypePath, { eventType: 'batch-quality-scored' }).events;
    assert.equal(withoutTypeEvents.length, 1);
    assert.ok(!('workloadType' in withoutTypeEvents[0].payload), 'omitting options.workloadType must leave the event payload with no such key, exactly matching the pre-change shape');

    // Every other payload field must be identical regardless of the workloadType option.
    const { workloadType: _omit, ...restWithType } = withTypeEvents[0].payload;
    assert.deepEqual(restWithType, withoutTypeEvents[0].payload);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeRoute(): without a ledgerPath option, quality scoring is still computed but NO ledger I/O occurs (backward-compatible default)', () => {
  const routeDecision = buildRouteDecision({ taskId: 'task-no-ledger', primaryProvider: 'anthropic' });
  const goodEnvelope = { answer: 'All good, nothing quantified here.', claims: [] };

  const batchResults = [
    {
      provider: 'anthropic',
      batchIndex: 0,
      outcome: { status: 'success', actualTokens: 10, latencyMs: 1, output: JSON.stringify(goodEnvelope), errorDetail: null, errorClass: null, provider: 'anthropic' }
    }
  ];

  // No `options` argument at all -- exactly how every pre-existing caller
  // invokes mergeRoute() (see tests/merge.test.js).
  const result = mergeRoute(routeDecision, batchResults);
  assert.equal(result.qualityScores.length, 1);
  assert.equal(result.qualityScores[0].contextRatio, null, 'no contextRatio was supplied by the caller');
  assert.ok(Number.isFinite(result.qualityScores[0].combinedScore));
});
