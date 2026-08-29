/**
 * BATON dispatch — executor/gemini.js
 *
 * Google AI Studio (Gemini) execution adapter, via `@google/genai`.
 *
 * PACKAGE NAME NOTE (2026-08-29): the task brief named `@google/generative-ai`
 * as Google's Node client. That package is deprecated — Google's current,
 * actively-published SDK is `@google/genai` (verified on npm at build time;
 * this is the second time this project has had to re-check a Google SDK
 * rename, the first being noted in the task brief itself). `@google/genai`
 * is what is installed and imported here.
 *
 * THIS ADAPTER DOES NOT REUSE THE SHARED `classifyError()` FROM ./errors.js,
 * unlike groq.js/cerebras.js — and that is a finding, not an oversight.
 * `@google/genai` is NOT a Stainless-generated SDK and does not expose the
 * `AuthenticationError` / `RateLimitError` / `APIConnectionTimeoutError` /
 * `APIConnectionError` / `APIError` hierarchy the shared classifier expects.
 * Confirmed by listing the package's actual runtime exports
 * (`Object.keys(await import('@google/genai'))`): the ONLY exported error
 * class is `ApiError` (`{ status: number }`). Everything else in its error
 * hierarchy (`HTTPClientError`, `RequestTimeoutError`, `ConnectionError`,
 * `RequestAbortedError`, `InvalidRequestError`) is declared internally in
 * the SDK's own bundled `.d.ts` but is never exported as a value — importing
 * any of those names throws at import time, not just at type-check time. So
 * classification here has to key off `err.status` (a real HTTP status code)
 * and, for the timeout/connection family the SDK doesn't export, off the
 * real `constructor.name`/`.name` the SDK itself sets on the thrown instance
 * (`this.name = "RequestTimeoutError"` — confirmed by reading
 * node_modules/@google/genai/dist/node/index.mjs directly, not assumed).
 * This is a structural read of the object the SDK actually throws, the same
 * category of signal `errors.js`'s own fallback branch already uses
 * (`err.constructor?.name`), never a string-match against the message body.
 *
 * REAL SHAPE OBSERVED (not assumed from docs) — captured by constructing a
 * real `GoogleGenAI` client with a garbage API key and making one real
 * network call against `models.generateContent()`, 2026-08-29:
 *
 * Gemini (`@google/genai@2.19.0`), on `models.generateContent()`:
 *   constructor.name              -> "ApiError"
 *   err instanceof ApiError       -> true
 *   err.status                    -> 400   <- NOT 401. Google's own API
 *                                            returns HTTP 400 / INVALID_ARGUMENT
 *                                            for an invalid API key, not 401.
 *   err.name                      -> "ApiError"
 *   err.message (parsed)          -> {"error":{"code":400,"message":"API key not
 *                                     valid. Please pass a valid API key.",
 *                                     "status":"INVALID_ARGUMENT", ...}}
 *   own enumerable keys           -> name, status
 *
 * Consequence: because Google collapses "bad request" and "bad API key"
 * onto the identical `ApiError` class with the identical HTTP status (400),
 * there is no structural way to tell them apart at the errorClass level for
 * this SDK — both are labelled 'BadRequestError' below. This does NOT
 * corrupt the 4-value execution `status` enum: an authentication failure
 * already collapses to `status: 'error'` for every other provider too (see
 * errors.js's own doc comment on this exact point), so the ambiguity is
 * confined to the informational `errorClass` label, not the status the
 * reputation loop actually branches on.
 */

import { GoogleGenAI, ApiError } from '@google/genai';

/** The provider name this adapter registers under in executor/index.js. */
export const PROVIDER_NAME = 'gemini';

/** Override with `BATON_DISPATCH_GEMINI_MODEL` env var.
 *
 * MODEL AVAILABILITY NOTE (2026-08-29): the task brief named
 * `gemini-2.0-flash` as the expected current default. As of this check,
 * `gemini-2.0-flash` is listed as SHUT DOWN on ai.google.dev/gemini-api/docs
 * /models. `gemini-2.5-flash` is the closest currently-available
 * equivalent (1,048,576-token context, confirmed still live) — though it
 * too carries a published shutdown date (2026-10-16 per Google's own
 * changelog checked the same day). A newer `gemini-3.7-flash` exists
 * (released 2026-08-13, ~2 weeks before this check) but was judged too
 * freshly-released to trust as a stable default without more runway on
 * free-tier availability; re-verify before the October date above. */
export const DEFAULT_MODEL = process.env.BATON_DISPATCH_GEMINI_MODEL || 'gemini-2.5-flash';

/**
 * Build a real client. Zero-arg by default — the SDK resolves
 * `GEMINI_API_KEY` / `GOOGLE_API_KEY` from the environment rather than
 * hardcoding a key.
 */
export function createClient(options = {}) {
  return new GoogleGenAI(options);
}

/**
 * Call `models.generateContent()` and return the plain-text output plus
 * the ACTUAL token usage measured from the response — never the predicted
 * `expectedTokens` from route-contracts.js's heuristic.
 *
 * `@google/genai`'s `usageMetadata.totalTokenCount` is documented (the
 * SDK's own `GenerateContentResponseUsageMetadata` type comment) as "the
 * sum of prompt_token_count, candidates_token_count,
 * tool_use_prompt_token_count, and thoughts_token_count" — the real total,
 * used directly; falls back to promptTokenCount + candidatesTokenCount
 * only if the SDK ever omits it.
 *
 * `timeoutMs` is passed via the per-call `config.httpOptions.timeout`
 * (the SDK's own documented per-request override), not a client-level
 * option, since this adapter never reuses one client across calls with
 * different timeouts.
 *
 * @param {GoogleGenAI} client
 * @param {string} prompt
 * @param {{ model?: string, maxTokens?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<{ text: string, actualTokens: number, raw: object }>}
 */
export async function callGemini(client, prompt, opts = {}) {
  const { model = DEFAULT_MODEL, maxTokens = 4096, timeoutMs } = opts;

  const config = {
    maxOutputTokens: maxTokens,
    ...(Number.isFinite(timeoutMs) ? { httpOptions: { timeout: timeoutMs } } : {})
  };

  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config
  });

  const text = response.text ?? '';

  const usage = response.usageMetadata ?? {};
  const actualTokens = usage.totalTokenCount ?? (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0);

  return { text, actualTokens, raw: response };
}

/**
 * Classify a thrown `@google/genai` error into the shared outcome shape.
 * See the module doc comment above for why this cannot reuse
 * ./errors.js's `classifyError()` — Gemini's SDK exports one error class
 * (`ApiError`, keyed by HTTP status), not the five-class Stainless
 * hierarchy every other adapter here classifies against.
 */
export function classifyGeminiError(err) {
  const message = err?.message ?? String(err);
  const ctorName = err?.constructor?.name;
  const structuralName = err?.name;

  // Timeout / connection family: RequestTimeoutError, ConnectionError,
  // RequestAbortedError, InvalidRequestError all extend an UNEXPORTED
  // HTTPClientError base (confirmed via runtime export listing, see module
  // doc comment) — instanceof against them is impossible from outside the
  // package, so classification reads the real `.name`/`constructor.name`
  // the SDK itself assigns on construction, never the message text.
  if (ctorName === 'RequestTimeoutError' || structuralName === 'RequestTimeoutError') {
    return { status: 'timeout', errorClass: 'RequestTimeoutError', errorDetail: message };
  }
  if (ctorName === 'ConnectionError' || structuralName === 'ConnectionError') {
    return { status: 'error', errorClass: 'ConnectionError', errorDetail: message };
  }
  if (ctorName === 'RequestAbortedError' || structuralName === 'RequestAbortedError') {
    return { status: 'error', errorClass: 'RequestAbortedError', errorDetail: message };
  }

  if (err instanceof ApiError) {
    const status = err.status;
    if (status === 429) {
      return { status: 'quota_exceeded', errorClass: 'RateLimitError', errorDetail: message };
    }
    if (status === 401) {
      return { status: 'error', errorClass: 'AuthenticationError', errorDetail: message };
    }
    if (status === 403) {
      return { status: 'error', errorClass: 'PermissionDeniedError', errorDetail: message };
    }
    if (status === 400) {
      // Observed: Google returns 400 (INVALID_ARGUMENT), not 401, for an
      // invalid API key — see the module doc comment. A genuinely malformed
      // request also lands here; both are 'BadRequestError' on this SDK.
      return { status: 'error', errorClass: 'BadRequestError', errorDetail: message };
    }
    if (typeof status === 'number' && status >= 500) {
      return { status: 'error', errorClass: 'InternalServerError', errorDetail: message };
    }
    return { status: 'error', errorClass: `ApiError_${status ?? 'unknown'}`, errorDetail: message };
  }

  // Not a recognized SDK error shape at all — still classified as 'error',
  // never silently swallowed, but flagged distinctly.
  return { status: 'error', errorClass: ctorName ?? 'UnknownError', errorDetail: message };
}
