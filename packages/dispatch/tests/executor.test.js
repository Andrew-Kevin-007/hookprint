import test from 'node:test';
import assert from 'node:assert/strict';

import AnthropicSDK from '@anthropic-ai/sdk';
import OpenAISDK from 'openai';
import GroqSDK from 'groq-sdk';
import CerebrasSDK from '@cerebras/cerebras_cloud_sdk';
import { GoogleGenAI, ApiError as GeminiApiError } from '@google/genai';

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
import { classifyGroqError } from '../executor/groq.js';
import { classifyCerebrasError } from '../executor/cerebras.js';
import { classifyGeminiError } from '../executor/gemini.js';
import { classifyOpenRouterError } from '../executor/openrouter.js';

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

test('executeBatch: successful Groq call returns status success, measured tokens, and OpenAI-compatible usage shape', async () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'groq', fallbackProviders: [] });
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'groq result' } }],
          usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 }
        })
      }
    }
  };

  const outcome = await executeBatch(routeDecision, sampleBatch, { client: mockClient, providerName: 'groq' });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.actualTokens, 620);
  assert.equal(outcome.output, 'groq result');
  assert.equal(outcome.provider, 'groq');
  assert.equal(outcome.errorDetail, null);
});

test('executeBatch: successful Cerebras call returns status success, measured tokens, and OpenAI-compatible usage shape', async () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'cerebras', fallbackProviders: [] });
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'cerebras result' } }],
          usage: { prompt_tokens: 400, completion_tokens: 90, total_tokens: 490 }
        })
      }
    }
  };

  const outcome = await executeBatch(routeDecision, sampleBatch, { client: mockClient, providerName: 'cerebras' });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.actualTokens, 490);
  assert.equal(outcome.output, 'cerebras result');
  assert.equal(outcome.provider, 'cerebras');
  assert.equal(outcome.errorDetail, null);
});

test('executeBatch: successful Gemini call returns status success, measured tokens from usageMetadata.totalTokenCount', async () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'gemini', fallbackProviders: [] });
  const mockClient = {
    models: {
      generateContent: async () => ({
        text: 'gemini result',
        usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80, totalTokenCount: 380 }
      })
    }
  };

  const outcome = await executeBatch(routeDecision, sampleBatch, { client: mockClient, providerName: 'gemini' });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.actualTokens, 380); // from totalTokenCount, not prompt+candidates guessed separately
  assert.equal(outcome.output, 'gemini result');
  assert.equal(outcome.provider, 'gemini');
  assert.equal(outcome.errorDetail, null);
});

test('executeBatch: successful OpenRouter call returns status success via the reused OpenAI-shaped adapter', async () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'openrouter', fallbackProviders: [] });
  const mockClient = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'openrouter result' } }],
          usage: { prompt_tokens: 600, completion_tokens: 140, total_tokens: 740 }
        })
      }
    }
  };

  const outcome = await executeBatch(routeDecision, sampleBatch, { client: mockClient, providerName: 'openrouter' });

  assert.equal(outcome.status, 'success');
  assert.equal(outcome.actualTokens, 740);
  assert.equal(outcome.output, 'openrouter result');
  assert.equal(outcome.provider, 'openrouter');
  assert.equal(outcome.errorDetail, null);
});

test('executeBatch: identical output shape across all six registered providers (anthropic, openai, groq, cerebras, gemini, openrouter)', async () => {
  const routeDecision = makeRouteDecision({ primaryProvider: 'anthropic', fallbackProviders: [] });

  const clients = {
    anthropic: {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
        })
      }
    },
    openai: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 120 } }) } } },
    groq: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 120 } }) } } },
    cerebras: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 120 } }) } } },
    gemini: { models: { generateContent: async () => ({ text: 'ok', usageMetadata: { totalTokenCount: 120 } }) } },
    openrouter: { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 120 } }) } } }
  };

  const outcomes = {};
  for (const [providerName, client] of Object.entries(clients)) {
    outcomes[providerName] = await executeBatch(routeDecision, sampleBatch, { client, providerName });
  }

  const referenceKeys = Object.keys(outcomes.anthropic).sort();
  for (const [providerName, outcome] of Object.entries(outcomes)) {
    assert.deepEqual(Object.keys(outcome).sort(), referenceKeys, `${providerName} outcome shape diverged`);
    assert.equal(outcome.status, 'success');
    assert.equal(outcome.provider, providerName);
    assert.ok(Number.isFinite(outcome.actualTokens) && outcome.actualTokens > 0);
    assert.ok(Number.isFinite(outcome.latencyMs));
    assert.equal(typeof outcome.output, 'string');
    assert.equal(outcome.errorDetail, null);
    assert.equal(outcome.errorClass, null);
  }
});

test('classifyGroqError / classifyCerebrasError: real SDK error instances (constructed, no network) classify identically to Anthropic/OpenAI for the same status codes', () => {
  // Constructed with the exact fields observed in the real garbage-key
  // discovery call documented in executor/groq.js / executor/cerebras.js.
  const groqAuth = new GroqSDK.AuthenticationError(
    401,
    { error: { message: 'Invalid API Key', type: 'invalid_request_error', code: 'invalid_api_key' } },
    undefined,
    undefined
  );
  const groqRateLimit = new GroqSDK.RateLimitError(429, { error: { message: 'Rate limited' } }, undefined, undefined);
  const groqTimeout = new GroqSDK.APIConnectionTimeoutError({ message: 'Request timed out.' });

  assert.deepEqual(classifyGroqError(groqAuth), { status: 'error', errorClass: 'AuthenticationError', errorDetail: groqAuth.message });
  assert.deepEqual(classifyGroqError(groqRateLimit), { status: 'quota_exceeded', errorClass: 'RateLimitError', errorDetail: groqRateLimit.message });
  assert.deepEqual(classifyGroqError(groqTimeout), { status: 'timeout', errorClass: 'APIConnectionTimeoutError', errorDetail: groqTimeout.message });

  const cerebrasAuth = new CerebrasSDK.AuthenticationError(
    401,
    { message: 'Wrong API Key', type: 'invalid_request_error', param: 'api_key', code: 'wrong_api_key' },
    undefined,
    undefined
  );
  const cerebrasRateLimit = new CerebrasSDK.RateLimitError(429, { message: 'Rate limited' }, undefined, undefined);

  assert.deepEqual(classifyCerebrasError(cerebrasAuth), { status: 'error', errorClass: 'AuthenticationError', errorDetail: cerebrasAuth.message });
  assert.deepEqual(classifyCerebrasError(cerebrasRateLimit), { status: 'quota_exceeded', errorClass: 'RateLimitError', errorDetail: cerebrasRateLimit.message });
});

test('classifyOpenRouterError: reuses the OpenAI SDK error classes unmodified (OpenRouter is an OpenAI-shaped gateway, not a distinct SDK)', () => {
  const authErr = new OpenAISDK.AuthenticationError(401, { message: 'User not found.', code: 401 }, undefined, undefined);
  const rateLimitErr = new OpenAISDK.RateLimitError(429, { message: 'Rate limited' }, undefined, undefined);

  assert.deepEqual(classifyOpenRouterError(authErr), { status: 'error', errorClass: 'AuthenticationError', errorDetail: authErr.message });
  assert.deepEqual(classifyOpenRouterError(rateLimitErr), { status: 'quota_exceeded', errorClass: 'RateLimitError', errorDetail: rateLimitErr.message });
});

test('classifyGeminiError: Gemini has no distinct AuthenticationError/RateLimitError classes — classification keys off the real observed err.status on the one exported ApiError class', () => {
  // Shape observed in the real garbage-key discovery call documented in
  // executor/gemini.js: Google returns HTTP 400 (not 401) for an invalid
  // API key.
  const invalidKeyErr = new GeminiApiError({
    message: JSON.stringify({
      error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' }
    }),
    status: 400
  });
  const rateLimitErr = new GeminiApiError({ message: 'Resource exhausted', status: 429 });
  const permissionErr = new GeminiApiError({ message: 'Permission denied', status: 403 });
  const serverErr = new GeminiApiError({ message: 'Internal error', status: 500 });

  assert.ok(invalidKeyErr instanceof GeminiApiError);
  assert.deepEqual(classifyGeminiError(invalidKeyErr), { status: 'error', errorClass: 'BadRequestError', errorDetail: invalidKeyErr.message });
  assert.deepEqual(classifyGeminiError(rateLimitErr), { status: 'quota_exceeded', errorClass: 'RateLimitError', errorDetail: rateLimitErr.message });
  assert.deepEqual(classifyGeminiError(permissionErr), { status: 'error', errorClass: 'PermissionDeniedError', errorDetail: permissionErr.message });
  assert.deepEqual(classifyGeminiError(serverErr), { status: 'error', errorClass: 'InternalServerError', errorDetail: serverErr.message });

  // The timeout/connection family (RequestTimeoutError etc.) is not
  // exported by @google/genai (confirmed by runtime export listing — see
  // executor/gemini.js), so it cannot be constructed here the way the
  // exported classes above can. classifyGeminiError's structural
  // `.name`/`constructor.name` branch for it is exercised indirectly: a
  // plain object shaped like what the SDK actually throws (per
  // dist/node/index.mjs's `this.name = "RequestTimeoutError"`) still
  // classifies correctly, proving the check reads the real property, not
  // an `instanceof` this SDK cannot support for that class.
  const timeoutLike = Object.assign(new Error('Request timed out.'), { name: 'RequestTimeoutError' });
  assert.deepEqual(classifyGeminiError(timeoutLike), { status: 'timeout', errorClass: 'RequestTimeoutError', errorDetail: 'Request timed out.' });
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

// Same discovery discipline applied to the four providers added by this
// task (Google AI Studio/Gemini, Groq, Cerebras, OpenRouter). Each fails
// fast on an auth rejection before any quota is consumed — no cost.
test(
  'real SDK clients (Groq, Cerebras, Gemini, OpenRouter): a garbage API key produces a real auth-rejection classified correctly by each adapter',
  { timeout: 30000 },
  async () => {
    const groqClient = new GroqSDK({ apiKey: 'gsk_garbage_not_real_00000000000000000000000000' });
    try {
      await groqClient.chat.completions.create({
        // Auth is rejected before the model name is ever validated, so this
        // value does not affect the assertion -- kept in sync with
        // groq.js's DEFAULT_MODEL only so the file stops naming a model
        // Groq has since discontinued.
        model: 'openai/gpt-oss-120b',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      });
      assert.fail('expected the real Groq API to reject a garbage key');
    } catch (err) {
      assert.ok(err instanceof GroqSDK.AuthenticationError, `expected AuthenticationError, got ${err.constructor.name}`);
      const classified = classifyGroqError(err);
      assert.equal(classified.status, 'error');
      assert.equal(classified.errorClass, 'AuthenticationError');
    }

    const cerebrasClient = new CerebrasSDK({ apiKey: 'csk-garbage-not-real-00000000000000000000000000' });
    try {
      await cerebrasClient.chat.completions.create({
        model: 'gpt-oss-120b',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      });
      assert.fail('expected the real Cerebras API to reject a garbage key');
    } catch (err) {
      assert.ok(err instanceof CerebrasSDK.AuthenticationError, `expected AuthenticationError, got ${err.constructor.name}`);
      const classified = classifyCerebrasError(err);
      assert.equal(classified.status, 'error');
      assert.equal(classified.errorClass, 'AuthenticationError');
    }

    const geminiClient = new GoogleGenAI({ apiKey: 'AIzaGarbageNotReal00000000000000000' });
    try {
      await geminiClient.models.generateContent({ model: 'gemini-2.5-flash', contents: 'hi' });
      assert.fail('expected the real Gemini API to reject a garbage key');
    } catch (err) {
      // NOT AuthenticationError — Gemini exports only ApiError (see
      // executor/gemini.js); the observed real rejection is status 400.
      assert.ok(err instanceof GeminiApiError, `expected ApiError, got ${err.constructor.name}`);
      assert.equal(err.status, 400);
      const classified = classifyGeminiError(err);
      assert.equal(classified.status, 'error');
      assert.equal(classified.errorClass, 'BadRequestError');
    }

    const openrouterClient = new OpenAISDK({
      apiKey: 'sk-or-v1-garbage-not-real-00000000000000000000000000000000',
      baseURL: 'https://openrouter.ai/api/v1'
    });
    try {
      await openrouterClient.chat.completions.create({
        model: 'google/gemma-4-31b-it:free',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      });
      assert.fail('expected the real OpenRouter API to reject a garbage key');
    } catch (err) {
      assert.ok(err instanceof OpenAISDK.AuthenticationError, `expected AuthenticationError, got ${err.constructor.name}`);
      const classified = classifyOpenRouterError(err);
      assert.equal(classified.status, 'error');
      assert.equal(classified.errorClass, 'AuthenticationError');
    }
  }
);

test('getProviderAdapter resolves all six registered providers (anthropic, openai, groq, cerebras, gemini, openrouter)', () => {
  for (const providerName of ['anthropic', 'openai', 'groq', 'cerebras', 'gemini', 'openrouter']) {
    const adapter = getProviderAdapter(providerName);
    assert.equal(typeof adapter.createClient, 'function');
    assert.equal(typeof adapter.call, 'function');
    assert.equal(typeof adapter.classify, 'function');
    assert.equal(typeof adapter.defaultModel, 'string');
  }
});
