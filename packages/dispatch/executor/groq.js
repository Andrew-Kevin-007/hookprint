/**
 * BATON dispatch — executor/groq.js
 *
 * Groq-specific execution adapter. Groq's Node SDK (`groq-sdk`) is generated
 * by the same Stainless toolchain as `@anthropic-ai/sdk` and `openai`, and
 * exposes the identical error-class hierarchy (verified below), so this
 * adapter mirrors anthropic.js/openai.js exactly: constructor-injected
 * client, same call signature, same return shape.
 *
 * REAL SHAPE OBSERVED (not assumed from docs) — captured by constructing a
 * real Groq client with a garbage API key and making one real network call
 * against `chat.completions.create()`, 2026-08-29:
 *
 * Groq (`groq-sdk@1.6.0`), 401 on `chat.completions.create()`:
 *   constructor.name              -> "AuthenticationError"
 *   err instanceof Groq.AuthenticationError -> true
 *   err instanceof Groq.APIError            -> true
 *   err.status                    -> 401
 *   err.message                   -> '401 {"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}'
 *   err.error (parsed body)        -> { error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }
 *   own enumerable keys           -> status, headers, error
 *
 * `groq-sdk`'s `error.d.ts` exports the same five classes anthropic.js /
 * openai.js classify against (`AuthenticationError`, `RateLimitError`,
 * `APIConnectionTimeoutError`, `APIConnectionError`, `APIError`, plus named
 * subclasses like `BadRequestError`), so the shared `classifyError()` from
 * ./errors.js is reused unmodified — no Groq-specific classification logic
 * needed.
 */

import Groq from 'groq-sdk';
import { classifyError } from './errors.js';

/** The provider name this adapter registers under in executor/index.js. */
export const PROVIDER_NAME = 'groq';

/** Override with `BATON_DISPATCH_GROQ_MODEL` env var. Groq's free-tier
 * production model with the largest context window among the fast-inference
 * options — confirmed still listed on console.groq.com/docs/models as of
 * 2026-08-29 (some providers have since dropped their Llama offerings
 * entirely, see cerebras.js). */
export const DEFAULT_MODEL = process.env.BATON_DISPATCH_GROQ_MODEL || 'llama-3.3-70b-versatile';

/** The error classes this adapter classifies against — real exports of the
 * installed `groq-sdk`, never re-declared or guessed. */
const ERROR_CLASSES = {
  AuthenticationError: Groq.AuthenticationError,
  RateLimitError: Groq.RateLimitError,
  APIConnectionTimeoutError: Groq.APIConnectionTimeoutError,
  APIConnectionError: Groq.APIConnectionError,
  APIError: Groq.APIError
};

/**
 * Build a real client. Zero-arg by default — the SDK resolves
 * `GROQ_API_KEY` from the environment rather than hardcoding a key.
 */
export function createClient(options = {}) {
  return new Groq(options);
}

/**
 * Call `chat.completions.create()` and return the plain-text output plus
 * the ACTUAL token usage measured from the response — never the predicted
 * `expectedTokens` from route-contracts.js's heuristic.
 *
 * Groq's OpenAI-compatible `usage` object reports `prompt_tokens`,
 * `completion_tokens`, and `total_tokens` — identical shape to openai.js.
 *
 * @param {Groq} client
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, actualTokens: number, raw: object }>}
 */
export async function callGroq(client, prompt, opts = {}) {
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

/** Classify a thrown Groq SDK error into the shared outcome shape. */
export function classifyGroqError(err) {
  return classifyError(err, ERROR_CLASSES);
}
