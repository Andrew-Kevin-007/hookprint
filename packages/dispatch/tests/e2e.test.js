/**
 * QUORUM dispatch — tests/e2e.test.js
 *
 * Phase 6, the one test nothing else in this codebase is: proof that all
 * seven of the plan's execution steps actually chain together in ONE real
 * run — intake -> profile -> predict -> route -> execute -> merge -> score
 * -> sign -> verify -> dashboard. Every phase before this test was built and
 * tested in isolation (route-contracts.js, profiling/predict.js,
 * ledger/curves.js, executor/*, merge/*, trace/*, execution-contracts.js all
 * have their own green suites) — none of those suites prove the pieces fit
 * together when handed real outputs from one another. This test is that
 * proof, and NO step below is mocked away or shortcut to make it pass
 * easier: the mock providers are the only fakes (there is no live network
 * access in this repo's test run), everything else — parsing, scoring,
 * ledger I/O, signing, verification, dashboard aggregation — is the real
 * code path.
 *
 * The planted contradiction (envelopeA/envelopeB below) reuses the exact
 * fixture technique from tests/merge.test.js's own
 * "INTEGRATION: intake -> plan -> execute two mock-provider batches -> merge
 * catches a planted contradiction" test: two batches independently reporting
 * the same subject ("dispatch records that failed verification") at a real,
 * detectable, different rate (2 of 37 ~= 5.4% vs 40%).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildTaskRequest, analyzeTaskQuality, planBatches, buildRouteDecision } from '../route-contracts.js';
import { predictQuality, staticPriorCurveLookup } from '../profiling/predict.js';
import { learnedCurveLookup, fitDegradationCurve } from '../ledger/curves.js';
import { executeBatch, buildPromptFromBatch } from '../executor/index.js';
import { buildEnvelopePrompt } from '../executor/envelope.js';
import { mergeRoute } from '../merge/index.js';
import { compareOutcome } from '../trace/outcome.js';
import { assembleExecutionTrace, signExecutionTrace, verifyExecutionTrace } from '../trace/index.js';
import { buildDashboardSnapshot } from '../execution-contracts.js';
import { generateIdentity } from '../../sign/index.js';

test('E2E: intake -> profile -> predict -> route -> execute -> merge -> score -> sign -> verify -> dashboard, one real chained run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-e2e-test-'));
  const ledgerPath = join(dir, 'ledger.jsonl');

  try {
    /* ---------------------------------------------------------------- */
    /* Step 1: intake -- a real task with real multi-quantity content.   */
    /* ---------------------------------------------------------------- */
    const task = buildTaskRequest({
      taskId: 'task-e2e-1',
      kind: 'document-analysis',
      items: [
        { id: 'a', content: 'Dispatch log excerpt A: 2 of 37 dispatch records failed verification this week.' },
        { id: 'b', content: 'Dispatch log excerpt B: roughly 40% of dispatch records failed verification this week.' }
      ],
      // qualityTarget: 0 is required to reach analyzeTaskQuality()'s
      // heuristic/workload-classification branch: buildTaskRequest() always
      // defaults qualityTarget to 0.85 when it is not explicitly falsy, and
      // analyzeTaskQuality() short-circuits to an 'explicit'/prediction:null
      // result whenever qualityTarget is already a positive finite number.
      // Same documented pattern route-contracts.test.js already uses for
      // exactly this reason ("qualityTarget: 0 // trigger the heuristic
      // fallback path") -- not a workaround invented for this test.
      qualityTarget: 0
    });
    assert.equal(task.items.length, 2);

    /* ---------------------------------------------------------------- */
    /* Step 2: profile -- real workload classification via                */
    /* analyzeTaskQuality(), which internally calls classifyWorkload().   */
    /* ---------------------------------------------------------------- */
    const analysis = analyzeTaskQuality(task);
    assert.ok(typeof analysis.prediction.workloadType === 'string' && analysis.prediction.workloadType.length > 0);
    assert.ok(Number.isFinite(analysis.prediction.workloadConfidence));

    const workloadClassification = {
      workloadType: analysis.prediction.workloadType,
      confidence: analysis.prediction.workloadConfidence
    };

    /* ---------------------------------------------------------------- */
    /* Step 3: route -- planBatches()/buildRouteDecision() with 2 real    */
    /* mock providers, 2 batches (one item each, matching                */
    /* merge.test.js's own INTEGRATION fixture split).                    */
    /* ---------------------------------------------------------------- */
    const providers = [
      { name: 'anthropic', tokensPerItem: 500, contextWindow: 100000, maxBatchSize: 10, qualityCurve: { low: 0.92, medium: 0.85, high: 0.7 } },
      { name: 'openai', tokensPerItem: 500, contextWindow: 100000, maxBatchSize: 10, qualityCurve: { low: 0.9, medium: 0.82, high: 0.68 } }
    ];

    const plan = planBatches(task, providers);
    assert.ok(plan.length >= 2, 'expected planBatches to produce a fit for both providers');

    const routeDecision = buildRouteDecision({
      taskId: task.taskId,
      decisionId: 'route-e2e-1',
      primaryProvider: plan[0].provider,
      fallbackProviders: [plan[1].provider],
      batchPlan: [
        { batchIndex: 0, itemIds: ['a'], expectedTokens: 500 },
        { batchIndex: 1, itemIds: ['b'], expectedTokens: 500 }
      ],
      qualityTarget: 0.85,
      reasoning: { taskKind: task.kind, selectedReason: 'quality-optimal', alternativeProviders: [plan[1].provider], rejectedReasons: {} }
    });
    assert.equal(routeDecision.batchPlan.length, 2);

    const providerByName = Object.fromEntries(providers.map((p) => [p.name, p]));
    const batchDefs = [
      { provider: 'anthropic', batchIndex: 0, items: [task.items[0]] },
      { provider: 'openai', batchIndex: 1, items: [task.items[1]] }
    ];

    /* ---------------------------------------------------------------- */
    /* Step 4: predict -- BEFORE execution, per batch, against an EMPTY   */
    /* temp ledger. This must genuinely fall back to the static prior:    */
    /* the ledger file does not exist yet at this point, so                */
    /* fitDegradationCurve() has zero events for either provider.         */
    /* ---------------------------------------------------------------- */
    assert.equal(existsSync(ledgerPath), false, 'ledger must not exist yet -- prediction runs before any execution/merge I/O');

    const preflightFits = batchDefs.map((b) => fitDegradationCurve(ledgerPath, b.provider));
    for (const fit of preflightFits) {
      assert.equal(fit.method, 'insufficient_data', `expected no learned curve yet for ${fit.provider} (empty ledger)`);
      assert.equal(fit.sampleCount, 0);
    }

    const predictions = batchDefs.map((b) => {
      const provider = providerByName[b.provider];
      const batchSize = b.items.length;
      const viaLearned = predictQuality(task, provider, workloadClassification, batchSize, learnedCurveLookup(ledgerPath));
      const viaStatic = predictQuality(task, provider, workloadClassification, batchSize, staticPriorCurveLookup);

      // The actual proof the fallback path fired: with a genuinely empty
      // ledger, routing predictQuality() through learnedCurveLookup() must
      // produce EXACTLY the same result as calling staticPriorCurveLookup()
      // directly -- not merely "some number", but the same number, because
      // learnedCurveLookup() had nothing to learn from and fell all the way
      // through to real code reuse of staticPriorCurveLookup() itself.
      assert.deepEqual(viaLearned, viaStatic, `expected ${b.provider}'s learned-lookup prediction to equal the static prior (cold start)`);
      assert.equal(viaLearned.curveSource, 'static_prior');
      assert.ok(Number.isFinite(viaLearned.predictedQuality) && viaLearned.predictedQuality > 0);

      return { ...b, prediction: viaLearned };
    });

    /* ---------------------------------------------------------------- */
    /* Step 5: execute -- real executeBatch() calls against mock clients, */
    /* options.buildPrompt wired to buildEnvelopePrompt, planting the      */
    /* genuine cross-batch contradiction (reused from merge.test.js).     */
    /* ---------------------------------------------------------------- */
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

    const buildPrompt = (rd, batch) => buildEnvelopePrompt(buildPromptFromBatch(rd, batch), { kind: rd.reasoning.taskKind });

    const outcomeA = await executeBatch(routeDecision, batchDefs[0].items, { client: clientA, providerName: 'anthropic', buildPrompt });
    const outcomeB = await executeBatch(routeDecision, batchDefs[1].items, { client: clientB, providerName: 'openai', buildPrompt });

    assert.equal(outcomeA.status, 'success');
    assert.equal(outcomeB.status, 'success');
    assert.match(capturedPromptA, /"claims"/);
    assert.match(capturedPromptB, /"claims"/);
    assert.ok(outcomeA.actualTokens > 0 && outcomeB.actualTokens > 0, 'expected real measured token usage from the mock calls, not a fabricated number');

    // contextRatio per batch, same formula predictQuality()/estimateProviderFit()
    // use internally (tokensPerItem * batchSize / contextWindow). mergeRoute()'s
    // own JSDoc documents this as an OPTIONAL per-batch-result field consumed by
    // Phase 2's quality scoring / Phase 4's curve fitting -- omitting it doesn't
    // throw (mergeRoute degrades gracefully), but it silently starves
    // fitDegradationCurve() of real data later in step 12, since curves.js
    // requires a finite contextRatio for a ledger event to count as a usable
    // sample. Threading it through here is what makes step 12's curve fit
    // real rather than empty.
    const contextRatioFor = (b) => {
      const provider = providerByName[b.provider];
      return (provider.tokensPerItem * b.items.length) / provider.contextWindow;
    };

    const batchResults = [
      { provider: 'anthropic', batchIndex: 0, outcome: outcomeA, contextRatio: contextRatioFor(batchDefs[0]) },
      { provider: 'openai', batchIndex: 1, outcome: outcomeB, contextRatio: contextRatioFor(batchDefs[1]) }
    ];

    /* ---------------------------------------------------------------- */
    /* Step 6: merge -- mergeRoute() with options.ledgerPath pointing at  */
    /* the SAME temp ledger. This merges, scores, AND logs                */
    /* 'batch-quality-scored' events in one call.                         */
    /* ---------------------------------------------------------------- */
    const mergeResult = mergeRoute(routeDecision, batchResults, { ledgerPath, taskId: task.taskId });

    assert.equal(mergeResult.status, 'CONTRADICTIONS_FOUND', 'the planted 2-of-37-vs-40% contradiction must be caught, not silently resolved');
    assert.equal(mergeResult.verification.contradictions.length, 1);
    assert.equal(mergeResult.failedBatches.length, 0);
    assert.equal(mergeResult.qualityScores.length, 2);
    assert.ok(existsSync(ledgerPath), 'mergeRoute() with a ledgerPath must have actually written the ledger file');

    /* ---------------------------------------------------------------- */
    /* Step 7: predicted-vs-actual -- compareOutcome() per batch.         */
    /* ---------------------------------------------------------------- */
    const outcomeComparisons = predictions.map((p) => {
      const scored = mergeResult.qualityScores.find((q) => q.batchIndex === p.batchIndex);
      assert.ok(scored, `expected a quality score for batch ${p.batchIndex}`);
      const comparison = compareOutcome(p.prediction.predictedQuality, scored.combinedScore);

      assert.ok(Number.isFinite(comparison.delta), 'delta must be a real finite number');
      assert.ok(['over-predicted', 'under-predicted', 'accurate'].includes(comparison.direction));
      assert.equal(comparison.predictedQuality, p.prediction.predictedQuality);
      assert.equal(comparison.actualQuality, scored.combinedScore);

      return comparison;
    });
    assert.equal(outcomeComparisons.length, 2);

    /* ---------------------------------------------------------------- */
    /* Step 8: assemble the whole run into one execution trace.           */
    /* ---------------------------------------------------------------- */
    const assembledAt = '2026-08-30T00:00:00.000Z';
    const trace = assembleExecutionTrace({
      task,
      workloadClassification,
      routeDecision,
      batchResults,
      mergeResult,
      outcomeComparisons,
      assembledAt
    });

    assert.equal(trace.execution.batchCount, 2);
    assert.equal(trace.execution.successCount, 2);
    assert.equal(trace.merge.status, 'CONTRADICTIONS_FOUND');
    assert.equal(trace.merge.contradictionCount, 1);
    assert.ok(trace.execution.totalActualTokens > 0, 'trace must carry the real summed token usage from step 5');
    assert.equal(trace.outcomeComparisons.length, 2);

    /* ---------------------------------------------------------------- */
    /* Step 9: sign with a real generateIdentity() keypair.               */
    /* ---------------------------------------------------------------- */
    const identity = generateIdentity();
    const signed = signExecutionTrace(trace, identity.privateKey, identity.publicKey);
    assert.equal(typeof signed.attestation.signature, 'string');
    assert.equal(signed.attestation.publicKey, identity.publicKey);

    /* ---------------------------------------------------------------- */
    /* Step 10: verify -- untampered, must be true.                       */
    /* ---------------------------------------------------------------- */
    assert.equal(verifyExecutionTrace(signed), true);

    /* ---------------------------------------------------------------- */
    /* Step 11: tamper ONE field NOT already covered by trace.test.js's   */
    /* two existing tamper tests (which tamper                            */
    /* `merge.contradictionCount` and `routeDecision.primaryProvider`).   */
    /* This test tampers `execution.totalActualTokens` instead -- new     */
    /* coverage, and a field whose real value only exists because this    */
    /* run actually executed two batches for real in step 5.              */
    /* ---------------------------------------------------------------- */
    assert.ok(
      trace.execution.totalActualTokens !== 999999,
      'sanity: the real totalActualTokens must differ from the tamper value chosen below'
    );
    const tampered = {
      ...signed,
      trace: { ...signed.trace, execution: { ...signed.trace.execution, totalActualTokens: 999999 } }
    };
    assert.equal(verifyExecutionTrace(tampered), false, 'tampering execution.totalActualTokens must flip verification to false');
    // The untampered original must still verify true -- tampering a copy must never have mutated the signed original.
    assert.equal(verifyExecutionTrace(signed), true);

    /* ---------------------------------------------------------------- */
    /* Step 12: dashboard -- buildDashboardSnapshot() including this      */
    /* trace and a fitDegradationCurve() computed against the SAME temp   */
    /* ledger, which now has real 'batch-quality-scored' events from      */
    /* step 6.                                                            */
    /* ---------------------------------------------------------------- */
    const degradationCurves = providers.map((p) => fitDegradationCurve(ledgerPath, p.name));
    for (const curve of degradationCurves) {
      // Real, if sparse, data: exactly one batch-quality-scored event per
      // provider was logged in step 6 -- far below MIN_BUCKET_SAMPLES (5),
      // so the honest result is "insufficient_data" with a real sampleCount
      // of 1, never a fabricated learned curve from a single sample.
      assert.equal(curve.sampleCount, 1, `expected exactly one real quality-scored sample for ${curve.provider}`);
      assert.equal(curve.method, 'insufficient_data');
      assert.equal(curve.confidence, 'none');
      assert.equal(curve.curve, null);
    }

    const snapshot = buildDashboardSnapshot({
      taskRouteDecisions: [],
      providerProfiles: [],
      executionTraces: [trace],
      degradationCurves
    });

    assert.equal(snapshot.traces.length, 1);
    assert.equal(snapshot.traces[0].traceId, trace.traceId, 'dashboard trace entry must trace back to THIS run\'s real traceId');
    assert.equal(snapshot.traces[0].status, 'CONTRADICTIONS_FOUND');
    assert.equal(snapshot.traces[0].contradictionCount, 1);
    assert.ok(Number.isFinite(snapshot.traces[0].meanOutcomeAccuracy), 'meanOutcomeAccuracy must be a real computed number, not a placeholder');

    assert.equal(snapshot.degradation.length, 2);
    const byProvider = Object.fromEntries(snapshot.degradation.map((d) => [d.provider, d]));
    assert.ok(byProvider.anthropic && byProvider.openai, 'dashboard degradation entries must name both real providers from this run');
    assert.equal(byProvider.anthropic.sampleCount, 1);
    assert.equal(byProvider.openai.sampleCount, 1);
    assert.equal(byProvider.anthropic.method, 'insufficient_data');
    assert.equal(byProvider.anthropic.curve, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
