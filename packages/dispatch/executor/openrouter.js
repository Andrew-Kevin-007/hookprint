/**
 * BATON dispatch — executor/openrouter.js
 *
 * OpenRouter-specific execution adapter. OpenRouter has no dedicated Node
 * SDK — it is an OpenAI-Chat-Completions-API-compatible gateway, so this
 * adapter reuses the already-installed `openai` package pointed at
 * OpenRouter's base URL (`https://openrouter.ai/api/v1`), exactly the
 * approach the task brief called for. Verified for real below: the `openai`
 * SDK's own `instanceof AuthenticationError`/`APIError` classification
 * works unmodified against OpenRouter's real error responses, so no
 * OpenRouter-specific classifier is needed — ./errors.js's shared
 * `classifyError()` is reused with the SAME `OpenAI.*` error classes
 * openai.js already imports.
 *
 * REAL SHAPE OBSERVED (not assumed from docs) — captured by constructing a
 * real `openai` client with `baseURL: 'https://openrouter.ai/api/v1'` and a
 * garbage API key, making one real network call against
 * `chat.completions.create()`, 2026-08-29:
 *
 * OpenRouter (via `openai@4.104.0` SDK), 401 on `chat.completions.create()`:
 *   constructor.name              -> "AuthenticationError"
 *   err instanceof OpenAI.AuthenticationError -> true
 *   err instanceof OpenAI.APIError            -> true
 *   err.status                    -> 401
 *   err.message                   -> '401 User not found.'
 *   err.error (parsed body)        -> { message: "User not found.", code: 401 }
 *   own enumerable keys           -> status, headers, request_id, error, code, param, type
 *
 * MODEL AVAILABILITY NOTE (2026-08-29): the task brief's example free model
 * (`meta-llama/llama-3.3-70b-instruct:free`) is NOT currently in
 * OpenRouter's free catalog — queried the real, unauthenticated
 * `GET https://openrouter.ai/api/v1/models` endpoint directly and filtered
 * for `id` ending in `:free`: 18 free models are live right now, and NONE
 * are Llama. `google/gemma-4-31b-it:free` (262144 context, pricing.prompt
 * = pricing.completion = "0") is used below instead — chosen because the
 * exact same base model (gemma-4-31b) is independently available on
 * Cerebras's free catalog too (see cerebras.js), which is stronger evidence
 * of being a real, current, non-transient offering than a single-source
 * pick. OpenRouter's free catalog is documented to rotate; re-query the
 * models endpoint before relying on this default long-term.
 */

import OpenAI from 'openai';
import { classifyError } from './errors.js';

/** The provider name this adapter registers under in executor/index.js. */
export const PROVIDER_NAME = 'openrouter';

/** OpenRouter's OpenAI-compatible base URL. */
export const BASE_URL = 'https://openrouter.ai/api/v1';

/** Override with `BATON_DISPATCH_OPENROUTER_MODEL` env var. See the
 * MODEL AVAILABILITY NOTE above. */
export const DEFAULT_MODEL = process.env.BATON_DISPATCH_OPENROUTER_MODEL || 'google/gemma-4-31b-it:free';

/** The error classes this adapter classifies against — the SAME real
 * exports of the installed `openai` package that openai.js uses; OpenRouter
 * is a gateway over the OpenAI Chat Completions API shape, not a different
 * SDK, so there is nothing provider-specific to inject here. */
const ERROR_CLASSES = {
  AuthenticationError: OpenAI.AuthenticationError,
  RateLimitError: OpenAI.RateLimitError,
  APIConnectionTimeoutError: OpenAI.APIConnectionTimeoutError,
  APIConnectionError: OpenAI.APIConnectionError,
  APIError: OpenAI.APIError
};

/**
 * Build a real client pointed at OpenRouter. Zero-arg by default — resolves
 * `OPENROUTER_API_KEY` from the environment (deliberately NOT
 * `OPENAI_API_KEY`, so a caller can hold both an OpenAI key and an
 * OpenRouter key at once without one silently shadowing the other).
 */
export function createClient(options = {}) {
  const { apiKey, ...rest } = options;
  return new OpenAI({
    apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
    baseURL: BASE_URL,
    ...rest
  });
}

/**
 * Call `chat.completions.create()` and return the plain-text output plus
 * the ACTUAL token usage measured from the response — never the predicted
 * `expectedTokens` from route-contracts.js's heuristic.
 *
 * OpenRouter's `usage` object mirrors OpenAI's: `prompt_tokens`,
 * `completion_tokens`, `total_tokens`.
 *
 * @param {OpenAI} client
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, actualTokens: number, raw: object }>}
 */
export async function callOpenRouter(client, prompt, opts = {}) {
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

/** Classify a thrown OpenRouter (openai-SDK-shaped) error into the shared
 * outcome shape. */
export function classifyOpenRouterError(err) {
  return classifyError(err, ERROR_CLASSES);
}
