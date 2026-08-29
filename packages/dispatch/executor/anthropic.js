/**
 * BATON dispatch — executor/anthropic.js
 *
 * Anthropic-specific execution adapter. Follows the same shape as
 * baton-swarm/lib/client.js: the SDK client is constructor-injected (never
 * imported and instantiated inline inside the call path), so tests can pass
 * a stub `{ messages: { create: async () => ({...}) } }` and exercise
 * request shaping, response parsing, and error classification with no
 * network access and no API key.
 */

import Anthropic from '@anthropic-ai/sdk';
import { classifyError } from './errors.js';

/** The provider name this adapter registers under in executor/index.js. */
export const PROVIDER_NAME = 'anthropic';

/** Override with `BATON_DISPATCH_ANTHROPIC_MODEL` env var. */
export const DEFAULT_MODEL = process.env.BATON_DISPATCH_ANTHROPIC_MODEL || 'claude-3-5-haiku-latest';

/** The error classes this adapter classifies against — real exports of the
 * installed `@anthropic-ai/sdk`, never re-declared or guessed. */
const ERROR_CLASSES = {
  AuthenticationError: Anthropic.AuthenticationError,
  RateLimitError: Anthropic.RateLimitError,
  APIConnectionTimeoutError: Anthropic.APIConnectionTimeoutError,
  APIConnectionError: Anthropic.APIConnectionError,
  APIError: Anthropic.APIError
};

/**
 * Build a real client. Zero-arg by default — same as swarm/lib/client.js,
 * let the SDK resolve `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
 * `ant auth login` from the environment rather than hardcoding a key.
 */
export function createClient(options = {}) {
  return new Anthropic(options);
}

/**
 * Call `messages.create()` and return the plain-text output plus the
 * ACTUAL token usage measured from the response — never the predicted
 * `expectedTokens` from route-contracts.js's heuristic.
 *
 * Anthropic's `usage` object splits input accounting across
 * `input_tokens`, `cache_creation_input_tokens`, and
 * `cache_read_input_tokens` (their sum is the true input total per the
 * SDK's own doc comment on `Usage`), plus `output_tokens`. actualTokens is
 * the sum of all four — the real, billed total for this call.
 *
 * @param {Anthropic} client
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, actualTokens: number, raw: object }>}
 */
export async function callAnthropic(client, prompt, opts = {}) {
  const { model = DEFAULT_MODEL, maxTokens = 4096, timeoutMs } = opts;

  const requestOptions = Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : undefined;

  const response = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    },
    requestOptions
  );

  const text = (response.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const usage = response.usage ?? {};
  const actualTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.output_tokens ?? 0);

  return { text, actualTokens, raw: response };
}

/** Classify a thrown Anthropic SDK error into the shared outcome shape. */
export function classifyAnthropicError(err) {
  return classifyError(err, ERROR_CLASSES);
}
