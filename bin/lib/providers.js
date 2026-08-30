/**
 * bin/lib/providers.js — which env var(s) each provider adapter reads, and
 * which of those are actually present right now.
 *
 * Pulled out of bin/quorum.js (which used to define this inline) so the
 * welcome screen and `quorum init` read the exact same list `campaign`/`run`
 * already gate on, instead of a second copy drifting out of sync.
 */

/**
 * One or more env vars that would let that provider's adapter construct a
 * real client (see each executor/*.js `createClient()`'s own doc comment
 * for which var(s) its SDK resolves). Gemini accepts either name — its SDK
 * (`@google/genai`) resolves `GEMINI_API_KEY` OR `GOOGLE_API_KEY`.
 */
export const PROVIDER_ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY']
};

/** Providers (in PROVIDER_ENV_VARS order) whose credential env var is
 * actually present right now. Never throws, never assumes a key exists. */
export function findAvailableProviders() {
  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([, envVars]) => envVars.some((name) => Boolean(process.env[name])))
    .map(([provider]) => provider);
}
