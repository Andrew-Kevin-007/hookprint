/**
 * bench/degradation/tests/campaign.test.js — the honest dry-run proof.
 *
 * There is no live API key anywhere in this environment (confirmed
 * repeatedly this session) — this suite cannot make a real provider call,
 * and does not pretend to. What it DOES prove, against the exact same
 * mocking pattern already used throughout this codebase
 * (`packages/dispatch/tests/executor.test.js`, `tests/merge.test.js`): the
 * full campaign harness — plan -> execute -> score -> ledger-log ->
 * resume -> analyze — is wired correctly end to end, and would attempt
 * real calls the moment a real client is supplied in place of a mock one
 * (this file's mocks implement the exact same adapter surface —
 * `messages.create()` / `chat.completions.create()` — a real SDK client
 * does).
 *
 * Location: alongside campaign.js/runner.js/analyze.js under
 * `bench/degradation/tests/`, matching this project's other packages'
 * convention (`packages/dispatch/tests/*.test.js`, `packages/align/tests/`,
 * etc. — one tests/ directory per package/module group). `bench/`'s
 * existing corruption benchmark (`bench/run.js`) has no tests/ directory of
 * its own — it is a deterministic report script proven by its own literal,
 * documented output, not by node:test assertions — so there was no
 * existing "bench tests" convention to match here; this instead follows
 * the more common per-package `tests/*.test.js` pattern used everywhere
 * else in the repo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// groq-sdk (not 'openai') for constructing a real RateLimitError instance
// below: npm's workspace hoisting left 'groq-sdk' at the repo root
// node_modules (resolvable from this file's location) but not 'openai' or
// '@anthropic-ai/sdk' (only resolvable from inside packages/dispatch,
// where its own tests live) -- groq-sdk is Stainless-generated with the
// identical error-class hierarchy openai's SDK has (see executor/groq.js's
// own doc comment), so it proves exactly the same real-SDK-error point.
import GroqSDK from 'groq-sdk';

import {
  buildCampaignPlan,
  validateBatchSizesAgainstProviderCeilings,
  loadRealCorpusChunks,
  BATCH_SIZES,
  PROVIDERS
} from '../campaign.js';
import { runCampaign, runCampaignCell, minIntervalMsFor } from '../runner.js';
import { readEvents } from '../../../packages/dispatch/ledger/store.js';
import { loadCampaignResults, computeDegradationCurve } from '../analyze.js';

/* -------------------------------------------------------------------------- */
/* Shared test fixtures — a small synthetic corpus, deliberately NOT the real */
/* fixtures/real-corpus/ files (those are exercised directly below in the     */
/* "real corpus" test) — a small, controlled corpus keeps the mock-quality    */
/* rigging in this file legible and the test suite fast.                     */
/* -------------------------------------------------------------------------- */

function makeCorpus(n) {
  const chunks = [];
  for (let i = 0; i < n; i += 1) {
    chunks.push({ id: `chunk-${i}`, content: `Chunk ${i}: the measured value here is 100 units out of 1000 total.` });
  }
  return chunks;
}

/** How many `--- item:` delimiters (executor/index.js's buildPromptFromBatch()
 * own delimiter) appear in the prompt actually sent — i.e. this cell's real
 * batch size, read back out of the real prompt text rather than assumed. */
function countItemsInPrompt(promptText) {
  const matches = String(promptText ?? '').match(/--- item:/g);
  return matches ? matches.length : 0;
}

/** A fully valid, grounded, non-degenerate envelope — scoreDeterministic()
 * should score this at or near 1.0. */
function goodEnvelope() {
  return {
    answer: 'The measured value is 100 units out of 1000 total, as stated in the input.',
    claims: [
      { subject: 'measured value here', value: 100, unit: 'units', denominator: 1000, basis: 'total', qualifier: 'measured', confidence: 0.9 }
    ]
  };
}

/** A syntactically valid but deliberately ungrounded envelope — simulates a
 * provider whose answer quality collapses under a larger batch: schema-valid
 * (passes parseEnvelope()), but its claim references nothing in the batch's
 * own input (subject shares no stems with "chunk/measured/value/units/total",
 * value never appears in the input text), so scoreDeterministic()'s grounding
 * check scores it 0. */
function badEnvelope() {
  return {
    answer: 'Unable to determine anything specific from this much text.',
    claims: [
      { subject: 'unrelated fabricated metric', value: 999999, unit: 'widgets', denominator: null, basis: null, qualifier: 'estimated', confidence: 0.3 }
    ]
  };
}

/** Anthropic-shaped mock client whose response quality depends on how many
 * items were ACTUALLY sent in the prompt (itemCount <= 1 -> good, else bad) —
 * this is what lets a single mock client simulate degradation as batch size
 * grows, exactly the shape a real provider degrading under load would
 * produce. */
function makeSmartAnthropicClient() {
  return {
    messages: {
      create: async (req) => {
        const itemCount = countItemsInPrompt(req.messages[0].content);
        const envelope = itemCount <= 1 ? goodEnvelope() : badEnvelope();
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
          usage: { input_tokens: 100 * Math.max(1, itemCount), output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        };
      }
    }
  };
}

/** Same rigging, OpenAI-shaped (chat.completions.create). */
function makeSmartOpenAIClient() {
  return {
    chat: {
      completions: {
        create: async (req) => {
          const itemCount = countItemsInPrompt(req.messages[0].content);
          const envelope = itemCount <= 1 ? goodEnvelope() : badEnvelope();
          return {
            choices: [{ message: { content: JSON.stringify(envelope) } }],
            usage: { prompt_tokens: 100 * Math.max(1, itemCount), completion_tokens: 40, total_tokens: 100 * Math.max(1, itemCount) + 40 }
          };
        }
      }
    }
  };
}

function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-campaign-test-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/* -------------------------------------------------------------------------- */
/* campaign.js — plan design                                                 */
/* -------------------------------------------------------------------------- */

test('validateBatchSizesAgainstProviderCeilings: the real BATCH_SIZES/PROVIDERS constants pass for every registered provider; a batch size above cerebras\'s ceiling is correctly flagged', () => {
  const real = validateBatchSizesAgainstProviderCeilings(BATCH_SIZES, PROVIDERS);
  assert.equal(real.ok, true, `expected BATCH_SIZES=${JSON.stringify(BATCH_SIZES)} to respect every provider's maxBatchSize, violations: ${JSON.stringify(real.violations)}`);

  // cerebras's maxBatchSize is 16 (provider-profiles.js) — the tightest of
  // all six, which is exactly why BATCH_SIZES stops at 16. Proving the
  // checker actually catches a violation, not just returning ok:true by
  // construction.
  const violating = validateBatchSizesAgainstProviderCeilings([1, 2, 4, 8, 16, 32], PROVIDERS);
  assert.equal(violating.ok, false);
  assert.ok(violating.violations.some((v) => v.provider === 'cerebras' && v.batchSize === 32));
});

test('loadRealCorpusChunks: the real fixtures/real-corpus/ files (not a synthetic stand-in) produce well more than the largest swept batch size in paragraph-level chunks', () => {
  const chunks = loadRealCorpusChunks();
  assert.ok(chunks.length > Math.max(...BATCH_SIZES), `expected > ${Math.max(...BATCH_SIZES)} chunks, got ${chunks.length}`);
  for (const chunk of chunks.slice(0, 5)) {
    assert.equal(typeof chunk.id, 'string');
    assert.equal(typeof chunk.content, 'string');
    assert.ok(chunk.content.length > 0);
  }
});

test('buildCampaignPlan: enumerates every (provider, batchSize, repetition) cell deterministically, with a unique taskId per cell', () => {
  const corpus = makeCorpus(4);
  const plan = buildCampaignPlan(corpus, [1, 2], ['anthropic', 'openai'], 2);

  assert.equal(plan.length, 2 * 2 * 2); // 2 providers x 2 batch sizes x 2 repetitions
  const taskIds = new Set(plan.map((c) => c.taskId));
  assert.equal(taskIds.size, plan.length, 'every cell must have a unique taskId');

  const anthropicBs1 = plan.find((c) => c.provider === 'anthropic' && c.batchSize === 1 && c.repetition === 1);
  assert.ok(anthropicBs1);
  assert.equal(anthropicBs1.batchContent.length, 1);
  assert.equal(anthropicBs1.batchContent[0].id, 'chunk-0');

  // Re-running the builder with the same arguments is byte-identical —
  // this is what lets the runner's resumability check key off taskId alone.
  const planAgain = buildCampaignPlan(corpus, [1, 2], ['anthropic', 'openai'], 2);
  assert.deepEqual(planAgain, plan);
});

/* -------------------------------------------------------------------------- */
/* runner.js — quota pacing                                                   */
/* -------------------------------------------------------------------------- */

test('minIntervalMsFor: derives pacing from each provider\'s real published rateLimits.rpm; providers with none configured (anthropic/openai) are not paced', () => {
  assert.equal(minIntervalMsFor('cerebras'), Math.ceil(60000 / 5)); // 5 rpm -> 12000ms
  assert.equal(minIntervalMsFor('groq'), Math.ceil(60000 / 30)); // 30 rpm -> 2000ms
  assert.equal(minIntervalMsFor('gemini'), Math.ceil(60000 / 15)); // 15 rpm -> 4000ms
  assert.equal(minIntervalMsFor('openrouter'), Math.ceil(60000 / 20)); // 20 rpm -> 3000ms
  assert.equal(minIntervalMsFor('anthropic'), 0);
  assert.equal(minIntervalMsFor('openai'), 0);
});

test('runCampaign: paces successive calls to a rate-limited provider by its real rpm, via an injected (non-blocking) sleep — proving the pacing code path actually runs, not just that it exists', async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const corpus = makeCorpus(2);
    const plan = buildCampaignPlan(corpus, [1], ['cerebras'], 3); // 3 cells, same provider

    const client = { chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(goodEnvelope()) } }], usage: { total_tokens: 140 } }) } } };
    const sleepCalls = [];
    const fakeSleep = async (ms) => {
      sleepCalls.push(ms);
    };

    await runCampaign(plan, { getClient: () => client, ledgerPath, sleep: fakeSleep });

    // 3 calls to the SAME rate-limited provider -> paced before the 2nd and
    // 3rd (never before the very first call, nothing to pace against yet).
    assert.equal(sleepCalls.length, 2, `expected exactly 2 paced waits for 3 same-provider calls, got ${sleepCalls.length}`);
    for (const ms of sleepCalls) {
      // cerebras: 12000ms minimum interval; mock calls resolve near-instantly,
      // so the paced wait should be very close to the full interval.
      assert.ok(ms > 11900 && ms <= 12000, `expected a pace close to 12000ms, got ${ms}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* INTEGRATION: full campaign run, resumability, quota halt, curve fitting    */
/* -------------------------------------------------------------------------- */

test('INTEGRATION: a full campaign run (2 providers x 3 batch sizes x 2 repetitions) accumulates exactly the right number of campaign-cell-completed events, and re-running against the SAME ledger correctly skips every already-completed cell', async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const corpus = makeCorpus(4);
    const batchSizes = [1, 2, 4];
    const providers = ['anthropic', 'openai'];
    const repetitions = 2;
    const plan = buildCampaignPlan(corpus, batchSizes, providers, repetitions);
    assert.equal(plan.length, 2 * 3 * 2); // = 12 cells — satisfies "at least 2 providers x 3 batch sizes x 2 repetitions"

    const clients = { anthropic: makeSmartAnthropicClient(), openai: makeSmartOpenAIClient() };
    const getClient = (provider) => clients[provider];

    const progressLog = [];
    const firstRun = await runCampaign(plan, {
      getClient,
      ledgerPath,
      onProgress: (cell, result) => progressLog.push({ cell, result })
    });

    // --- BEFORE/AFTER PROOF, quoted in the final report -------------------
    const beforeSecondRun = readEvents(ledgerPath, { eventType: 'campaign-cell-completed' });
    assert.equal(beforeSecondRun.events.length, 12, `expected exactly 12 campaign-cell-completed events after the first run, got ${beforeSecondRun.events.length}`);
    assert.equal(firstRun.results.length, 12);
    assert.equal(firstRun.skipped.length, 0, 'nothing should be skipped on a fresh ledger');
    assert.equal(progressLog.length, 12);
    for (const { result } of progressLog) {
      assert.equal(result.status, 'success');
      assert.ok(Number.isFinite(result.qualityScore));
    }

    // --- Resumability: re-run the SAME plan against the SAME ledger -------
    const secondRunProgress = [];
    const secondRun = await runCampaign(plan, {
      getClient,
      ledgerPath,
      onProgress: (cell, result) => secondRunProgress.push({ cell, result })
    });

    const afterSecondRun = readEvents(ledgerPath, { eventType: 'campaign-cell-completed' });
    assert.equal(afterSecondRun.events.length, 12, `expected the event count to stay at 12 after a full re-run (was 12 before), got ${afterSecondRun.events.length} -- a duplicate would prove resumability broken`);
    assert.equal(secondRun.results.length, 0, 'every cell should be skipped, not re-executed, on the second run');
    assert.equal(secondRun.skipped.length, 12);
    for (const { result } of secondRunProgress) {
      assert.equal(result.skipped, true);
      assert.match(result.reason, /already completed/);
    }

    /* ------------------------------------------------------------------ */
    /* analyze.js against this same ledger — the curve-fitting proof       */
    /* ------------------------------------------------------------------ */
    const loaded = loadCampaignResults(ledgerPath);
    assert.equal(loaded.length, 12);

    const anthropicCurve = computeDegradationCurve(loaded, 'anthropic');
    assert.equal(anthropicCurve.provider, 'anthropic');
    assert.equal(anthropicCurve.points.length, 3); // one bucket per batch size (1, 2, 4)
    for (const point of anthropicCurve.points) {
      assert.equal(point.n, 2); // 2 repetitions per cell
      assert.ok(Number.isFinite(point.contextRatio));
      assert.ok(Number.isFinite(point.meanQuality));
      assert.ok(Number.isFinite(point.stddev));
    }
    // Buckets sorted ascending by contextRatio (== ascending batch size here).
    for (let i = 1; i < anthropicCurve.points.length; i += 1) {
      assert.ok(anthropicCurve.points[i].contextRatio > anthropicCurve.points[i - 1].contextRatio);
    }

    // THE PROOF the analysis code actually works: batchSize 1 was rigged to
    // score high (goodEnvelope, grounded) and batchSize 2/4 rigged to score
    // low (badEnvelope, ungrounded) -- computeDegradationCurve must detect
    // a real, material drop between the smallest and largest bucket.
    const smallest = anthropicCurve.points[0];
    const largest = anthropicCurve.points[anthropicCurve.points.length - 1];
    assert.ok(smallest.meanQuality > largest.meanQuality, `expected smallest-context quality (${smallest.meanQuality}) > largest-context quality (${largest.meanQuality})`);
    assert.ok(smallest.meanQuality - largest.meanQuality > 0.05, `expected a drop exceeding the 0.05 threshold, got ${smallest.meanQuality - largest.meanQuality}`);
    assert.equal(anthropicCurve.trend, 'degrades', `expected trend 'degrades', got '${anthropicCurve.trend}'`);

    const openaiCurve = computeDegradationCurve(loaded, 'openai');
    assert.equal(openaiCurve.trend, 'degrades');
  });
});

test('computeDegradationCurve: too few samples anywhere reports insufficient_data rather than guessing a trend', () => {
  const sparse = [
    { provider: 'anthropic', contextRatio: 0.01, qualityScore: 0.9 },
    { provider: 'anthropic', contextRatio: 0.05, qualityScore: 0.5 }
  ]; // only 1 sample per bucket -- below MIN_SAMPLES_PER_BUCKET
  const curve = computeDegradationCurve(sparse, 'anthropic');
  assert.equal(curve.trend, 'insufficient_data');

  const empty = computeDegradationCurve([], 'anthropic');
  assert.equal(empty.trend, 'insufficient_data');
  assert.equal(empty.points.length, 0);
});

test('computeDegradationCurve: a genuinely flat quality signal across context loads is reported as flat, never a false "degrades"', () => {
  const flat = [];
  for (const ratio of [0.01, 0.02, 0.04]) {
    for (let i = 0; i < 3; i += 1) flat.push({ provider: 'anthropic', contextRatio: ratio, qualityScore: 0.9 });
  }
  const curve = computeDegradationCurve(flat, 'anthropic');
  assert.equal(curve.trend, 'flat');
});

/* -------------------------------------------------------------------------- */
/* Quota halt: one provider's quota_exceeded must not affect any other       */
/* -------------------------------------------------------------------------- */

test('INTEGRATION: a simulated quota_exceeded on one provider halts only THAT provider\'s remaining cells for the rest of this run — every other provider\'s cells still run to completion', async () => {
  await withTmpDir(async (dir) => {
    const ledgerPath = join(dir, 'ledger.jsonl');
    const corpus = makeCorpus(2);
    const batchSizes = [1, 2];
    const repetitions = 2;
    const plan = buildCampaignPlan(corpus, batchSizes, ['anthropic', 'groq'], repetitions);
    assert.equal(plan.length, 8); // 2 providers x 2 batch sizes x 2 repetitions

    // anthropic: healthy, every call succeeds.
    const anthropicClient = makeSmartAnthropicClient();

    // groq: every call throws a real RateLimitError (same real SDK error
    // class executor.test.js constructs, and the same Stainless-generated
    // hierarchy openai's SDK shares) -- simulating a provider whose
    // free-tier quota is genuinely exhausted.
    const rateLimitErr = new GroqSDK.RateLimitError(429, { error: { message: 'Rate limited' } }, undefined, undefined);
    const groqClient = { chat: { completions: { create: async () => { throw rateLimitErr; } } } };

    const clients = { anthropic: anthropicClient, groq: groqClient };
    const progressLog = [];
    const { results, haltedProviders, skipped } = await runCampaign(plan, {
      getClient: (provider) => clients[provider],
      ledgerPath,
      onProgress: (cell, result) => progressLog.push({ cell, result })
    });

    assert.deepEqual(haltedProviders, ['groq']);

    const anthropicResults = results.filter((r) => r.provider === 'anthropic');
    const groqResults = results.filter((r) => r.provider === 'groq');
    // ALL 4 anthropic cells ran to completion, untouched by groq's halt.
    assert.equal(anthropicResults.length, 4);
    for (const r of anthropicResults) assert.equal(r.status, 'success');

    // Only the FIRST groq cell was actually attempted (it is what
    // triggered the halt) -- the remaining 3 were skipped, never retried.
    assert.equal(groqResults.length, 1);
    assert.equal(groqResults[0].status, 'quota_exceeded');
    assert.equal(groqResults[0].qualityScore, null, 'a failed execution must never fabricate a quality score');

    const groqSkipped = skipped.filter((s) => s.cell.provider === 'groq');
    assert.equal(groqSkipped.length, 3);
    for (const s of groqSkipped) assert.match(s.reason, /halted earlier this run \(quota_exceeded\)/);

    // The skip was reported via onProgress, never silent.
    const skippedProgressEntries = progressLog.filter((p) => p.result?.skipped);
    assert.equal(skippedProgressEntries.length, 3);

    // The ledger reflects reality: exactly 1 groq event (the halting one,
    // recorded with its real quota_exceeded status) plus 4 anthropic
    // events -- never a duplicated or fabricated entry for a skipped cell.
    const { events } = readEvents(ledgerPath, { eventType: 'campaign-cell-completed' });
    assert.equal(events.length, 5);
    const groqEvents = events.filter((e) => e.provider === 'groq');
    assert.equal(groqEvents.length, 1);
    assert.equal(groqEvents[0].payload.status, 'quota_exceeded');
    assert.equal(groqEvents[0].payload.errorClass, 'RateLimitError');
  });
});

/* -------------------------------------------------------------------------- */
/* runCampaignCell in isolation -- envelope prompting genuinely wired in     */
/* -------------------------------------------------------------------------- */

test('runCampaignCell: the structured envelope prompt is genuinely sent (not decorative), and a failed execution records status/errorClass without ever inventing a quality score', async () => {
  const corpus = makeCorpus(1);
  const cell = { provider: 'anthropic', batchSize: 1, repetition: 1, taskId: 'campaign-anthropic-bs1-r1', batchContent: corpus };

  let capturedPrompt = null;
  const client = {
    messages: {
      create: async (req) => {
        capturedPrompt = req.messages[0].content;
        return {
          content: [{ type: 'text', text: JSON.stringify(goodEnvelope()) }],
          usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        };
      }
    }
  };

  const result = await runCampaignCell(cell, { client });
  assert.match(capturedPrompt, /"claims"/, 'the envelope schema instruction must actually be in the sent prompt');
  assert.equal(result.status, 'success');
  assert.ok(Number.isFinite(result.qualityScore) && result.qualityScore > 0);
  assert.ok(Number.isFinite(result.contextRatio));

  // Now a failing call.
  const failingClient = { messages: { create: async () => { throw new Error('simulated network failure'); } } };
  const failedResult = await runCampaignCell(cell, { client: failingClient });
  assert.equal(failedResult.status, 'error');
  assert.equal(failedResult.qualityScore, null);
  assert.equal(failedResult.actualTokens, 0);
});
