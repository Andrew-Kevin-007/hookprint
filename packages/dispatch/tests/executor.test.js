import test from 'node:test';
import assert from 'node:assert/strict';

import AnthropicSDK from '@anthropic-ai/sdk';
import OpenAISDK from 'openai';

import { buildRouteDecision } from '../route-contracts.js';
import { LEDGER_EVENT_TYPES } from '../execution-contracts.js';
import {
  executeBatch,
  buildExecutionLedgerEvent,
  pickNextFallbackProvider,
  getProviderAdapter
} from '../executor/index.js';
import { classifyAnthropicError } from '../executor/anthropic.js';
import { classifyOpenAIError } from '../executor/openai.js';

function makeRouteDecision(overrides = {}) {
  return buildRouteDecision({
    taskId: 'task-exec-1',
    primaryProvider: 'anthropic',
    qualityTarget: 0.9,
    fallbackProviders: ['openai', 'local'],
    batchPlan: [{ batchIndex: 0, itemIds: ['a', 'b'], expectedTokens: 5000 }],
    ...overrides
  });
}

const sampleBatch = [
  { id: 'a', content: 'First document chunk to analyze.' },
  { id: 'b', content: 'Second document chunk to analyze.' }
];

test('executeBatch: successful Anthropic call returns status success, measured tokens distinct from the prediction, and a valid ledger event', async () => {
  const routeDecision = makeRouteDecision();
  const mockClient = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'Analysis complete.' }],
        usage: { input_tokens: 1200, output_tokens: 340, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      })
    }
  };

  const outcome = await executeBatch(routeDecision, sampleBatch, { client: mockClient, providerName: 'anthropic' });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.actualTokens, 1540); // 1200 + 340, measured — NOT the predicted 5000
  assert.notEqual(outcome.actualTokens, routeDecision.batchPlan[0].expectedTokens);
  assert.equal(outcome.output, 'Analysis complete.');
  assert.equal(outcome.errorDetail, null);
  assert.ok(Number.isFinite(outcome.latencyMs));

  const ledgerEvent = buildExecutionLedgerEvent(routeDecision, outcome, { batchIndex: 0 });
  assert.ok(LEDGER_EVENT_TYPES.includes(ledgerEvent.eventType));
  assert.equal(ledgerEvent.eventType, 'task-completed');
  assert.equal(ledgerEvent.taskId, 'task-exec-1');
  assert.equal(ledgerEvent.provider, 'anthropic');
  assert.equal(ledgerEvent.payload.predictedTokens, 5000);
  assert.equal(ledgerEvent.payload.actualTokens, 1540);
  assert.notEqual(ledgerEvent.payload.predictedTokens, ledgerEvent.payload.actualTokens);
});

test('executeBatch: auth, rate-limit, generic API, and timeout errors from a mock client each produce a distinct status/errorClass — never one generic bucket', async () => {
  const routeDecision = makeRouteDecision();

  // Real SDK error instances (not hand-rolled shapes) — constructed directly
  // with no network call, exactly the fields the real SDK constructor
  // requires, per the discovery in executor/errors.js.
  const authErr = new AnthropicSDK.AuthenticationError(
    401,
    { type: 'error', error: { type: 'authentication_error', message: 'API key is invalid.' } },
    undefined,
    undefined,
    'authentication_error'
  );
  const rateLimitErr = new AnthropicSDK.RateLimitError(
    429,
    { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited.' } },
    undefined,
    undefined,
    'rate_limit_error'
  );
  const badRequestErr = new AnthropicSDK.BadRequestError(
    400,
    { type: 'error', error: { type: 'invalid_request_error', message: 'model field is required.' } },
    undefined,
    undefined,
    'invalid_request_error'
  );
  const timeoutErr = new AnthropicSDK.APIConnectionTimeoutError({ message: 'Request timed out.' });

  const makeClientThatThrows = (err) => ({
    messages: {
      create: async () => {
        throw err;
      }
    }
  });

  const authOutcome = await executeBatch(routeDecision, sampleBatch, { client: makeClientThatThrows(authErr), providerName: 'anthropic' });
  const rateLimitOutcome = await executeBatch(routeDecision, sampleBatch, { client: makeClientThatThrows(rateLimitErr), providerName: 'anthropic' });
  const badRequestOutcome = await executeBatch(routeDecision, sampleBatch, { client: makeClientThatThrows(badRequestErr), providerName: 'anthropic' });
  const timeoutOutcome = await executeBatch(routeDecision, sampleBatch, { client: makeClientThatThrows(timeoutErr), providerName: 'anthropic' });

  assert.equal(authOutcome.status, 'error');
  assert.equal(authOutcome.errorClass, 'AuthenticationError');

  assert.equal(rateLimitOutcome.status, 'quota_exceeded');
  assert.equal(rateLimitOutcome.errorClass, 'RateLimitError');

  assert.equal(badRequestOutcome.status, 'error');
  assert.equal(badRequestOutcome.errorClass, 'BadRequestError');

  assert.equal(timeoutOutcome.status, 'timeout');
  assert.equal(timeoutOutcome.errorClass, 'APIConnectionTimeoutError');

  // Four distinct (status, errorClass) pairs — never collapsed into one bucket,
  // even though auth and bad-request share the same top-level `status`.
  const pairs = [authOutcome, rateLimitOutcome, badRequestOutcome, timeoutOutcome].map((o) => `${o.status}:${o.errorClass}`);
  assert.equal(new Set(pairs).size, 4, `expected 4 distinct status:errorClass pairs, got ${pairs.join(', ')}`);

  // errorDetail is populated and actualTokens is never backfilled from the prediction on failure.
  for (const outcome of [authOutcome, rateLimitOutcome, badRequestOutcome, timeoutOutcome]) {
    assert.equal(outcome.actualTokens, 0);
    assert.ok(typeof outcome.errorDetail === 'string' && outcome.errorDetail.length > 0);
    assert.equal(outcome.output, null);
  }

  // Produces a 'task-failed' ledger event, distinguishable downstream via payload.errorClass.
  const ledgerEvent = buildExecutionLedgerEvent(routeDecision, authOutcome, { batchIndex: 0 });
  assert.equal(ledgerEvent.eventType, 'task-failed');
  assert.equal(ledgerEvent.payload.errorClass, 'AuthenticationError');
});

test('executeBatch: identical call path and output shape for both Anthropic and OpenAI mock clients', async () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'anthropic', fallbackProviders: ['openai'] });

  const anthropicClient = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: 'anthropic result' }],
        usage: { input_tokens: 800, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      })
    }
  };

  const openaiClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'openai result' } }],
          usage: { prompt_tokens: 700, completion_tokens: 150, total_tokens: 850 }
        })
      }
    }
  };

  const anthropicOutcome = await executeBatch(routeDecision, sampleBatch, { client: anthropicClient, providerName: 'anthropic' });
  const openaiOutcome = await executeBatch(routeDecision, sampleBatch, { client: openaiClient, providerName: 'openai' });

  for (const outcome of [anthropicOutcome, openaiOutcome]) {
    assert.equal(outcome.status, 'success');
    assert.ok(Number.isFinite(outcome.actualTokens) && outcome.actualTokens > 0);
    assert.ok(Number.isFinite(outcome.latencyMs));
    assert.equal(outcome.errorDetail, null);
    assert.equal(typeof outcome.output, 'string');
    assert.deepEqual(Object.keys(outcome).sort(), Object.keys(anthropicOutcome).sort());
  }

  assert.equal(anthropicOutcome.output, 'anthropic result');
  assert.equal(anthropicOutcome.actualTokens, 1000);
  assert.equal(openaiOutcome.output, 'openai result');
  assert.equal(openaiOutcome.actualTokens, 850);
});

test('pickNextFallbackProvider returns the next unattempted provider in the fallback chain, or null when exhausted', () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'anthropic', fallbackProviders: ['openai', 'local'] });

  assert.equal(pickNextFallbackProvider(routeDecision, []), 'openai');
  assert.equal(pickNextFallbackProvider(routeDecision, ['openai']), 'local');
  assert.equal(pickNextFallbackProvider(routeDecision, ['openai', 'local']), null);
});

test('getProviderAdapter throws a clear error for an unregistered provider', () => {
  assert.throws(() => getProviderAdapter('does-not-exist'), /no execution adapter registered/);
});

// Real network calls — deliberate, per the discovery comment in
// executor/errors.js. Constructs an actual SDK client with a garbage API
// key and observes what the SDK really throws, rather than assuming from
// documentation (this is the exact category of bug baton-swarm hit
// tonight: an `instanceof` check that didn't match the SDK's real shape).
// Both calls fail fast on a 401 before any quota is consumed.
test(
  'real SDK clients: a garbage API key produces a real AuthenticationError classified correctly by each adapter',
  { timeout: 20000 },
  async () => {
    const anthropicClient = new AnthropicSDK({ apiKey: 'sk-ant-garbage-not-real-00000000' });
    try {
      await anthropicClient.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      });
      assert.fail('expected the real Anthropic API to reject a garbage key');
    } catch (err) {
      assert.ok(err instanceof AnthropicSDK.AuthenticationError, `expected AuthenticationError, got ${err.constructor.name}`);
      const classified = classifyAnthropicError(err);
      assert.equal(classified.status, 'error');
      assert.equal(classified.errorClass, 'AuthenticationError');
    }

    const openaiClient = new OpenAISDK({ apiKey: 'sk-garbage-not-real-00000000' });
    try {
      await openaiClient.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      });
      assert.fail('expected the real OpenAI API to reject a garbage key');
    } catch (err) {
      assert.ok(err instanceof OpenAISDK.AuthenticationError, `expected AuthenticationError, got ${err.constructor.name}`);
      const classified = classifyOpenAIError(err);
      assert.equal(classified.status, 'error');
      assert.equal(classified.errorClass, 'AuthenticationError');
    }
  }
);
