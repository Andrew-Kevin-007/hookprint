/**
 * BATON dispatch — executor/openai.js
 *
 * OpenAI-specific execution adapter. Mirrors executor/anthropic.js exactly:
 * constructor-injected client, same call signature, same return shape, so
 * executor/index.js's `executeBatch()` can treat both providers
 * identically and a caller can retry against the other provider without
 * special-casing anything.
 */

import OpenAI from 'openai';
import { classifyError } from './errors.js';

/** The provider name this adapter registers under in executor/index.js. */
export const PROVIDER_NAME = 'openai';

/** Override with `BATON_DISPATCH_OPENAI_MODEL` env var. */
export const DEFAULT_MODEL = process.env.BATON_DISPATCH_OPENAI_MODEL || 'gpt-4o-mini';

/** The error classes this adapter classifies against — real exports of the
 * installed `openai` package, never re-declared or guessed. */
const ERROR_CLASSES = {
  AuthenticationError: OpenAI.AuthenticationError,
  RateLimitError: OpenAI.RateLimitError,
  APIConnectionTimeoutError: OpenAI.APIConnectionTimeoutError,
  APIConnectionError: OpenAI.APIConnectionError,
  APIError: OpenAI.APIError
};

/**
 * Build a real client. Zero-arg by default — the SDK resolves
 * `OPENAI_API_KEY` from the environment rather than hardcoding a key.
 */
export function createClient(options = {}) {
  return new OpenAI(options);
}

/**
 * Call `chat.completions.create()` and return the plain-text output plus
 * the ACTUAL token usage measured from the response — never the predicted
 * `expectedTokens` from route-contracts.js's heuristic.
 *
 * OpenAI's `usage` object reports `prompt_tokens`, `completion_tokens`,
 * and `total_tokens`. actualTokens uses `total_tokens` when present,
 * falling back to the sum of the two components only if it is absent.
 *
 * @param {OpenAI} client
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, actualTokens: number, raw: object }>}
 */
export async function callOpenAI(client, prompt, opts = {}) {
  const { model = DEFAULT_MODEL, maxTokens = 4096, timeoutMs } = opts;

  const requestOptions = Number.isFinite(timeoutMs) ? { timeout: timeoutMs } : undefined;

  const response = await client.chat.completions.create(
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    },
    requestOptions
  );

  const text = response.choices?.[0]?.message?.content ?? '';

  const usage = response.usage ?? {};
  const actualTokens = usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);

  return { text, actualTokens, raw: response };
}

/** Classify a thrown OpenAI SDK error into the shared outcome shape. */
export function classifyOpenAIError(err) {
  return classifyError(err, ERROR_CLASSES);
}
