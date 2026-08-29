/**
 * BATON — swarm/lib/client.js
 *
 * Thin wrapper around the official Anthropic SDK (`@anthropic-ai/sdk`). One
 * job: fail with a clear, actionable message when no credential is
 * configured, instead of the SDK's generic auth error surfacing three calls
 * deep into the pipeline with no context about what to do about it.
 *
 * Credential resolution itself is entirely the SDK's responsibility —
 * `new Anthropic()` already checks, in order: `ANTHROPIC_API_KEY`, then
 * `ANTHROPIC_AUTH_TOKEN`, then an `ant auth login` profile, then Workload
 * Identity Federation env vars. We do not re-implement that search here; we
 * only add a better error when all of it comes up empty, and a way to check
 * ahead of time so `run.js` can skip straight to a clear message instead of
 * making a network call that is guaranteed to fail.
 */

import Anthropic from '@anthropic-ai/sdk';

/**
 * Best-effort LOCAL hint that a credential is configured. This is not
 * authoritative — an `ant auth login` profile on disk with none of these
 * env vars set is still a valid credential and this returns `false` for it.
 * It exists only so `run.js` can print a fast, specific message before
 * spending a network round trip on a call that the SDK's own resolution
 * would also have failed. The SDK itself remains the actual authority.
 */
export function hasEnvCredential() {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      (process.env.ANTHROPIC_FEDERATION_RULE_ID && process.env.ANTHROPIC_ORGANIZATION_ID)
  );
}

/** The model this pipeline calls. Override with `BATON_SWARM_MODEL` (e.g. to
 * run the demo cheaply on `claude-haiku-4-5` instead of the default). */
export const MODEL = process.env.BATON_SWARM_MODEL || 'claude-opus-5';

/**
 * Build a client. Zero-arg — let the SDK resolve credentials from the
 * environment or an `ant auth login` profile rather than hardcoding a key.
 */
export function createClient() {
  return new Anthropic();
}

/**
 * Call the model once with a single user-turn prompt and return its plain
 * text reply. This is the one function `pipeline.js` depends on — it is
 * intentionally the entire surface between the pipeline logic and the SDK,
 * so tests can inject a stub with this exact signature and exercise the
 * pipeline's plumbing (prompt chaining, file writing) with no network call
 * and no key.
 *
 * @param {Anthropic} client
 * @param {string} prompt
 * @returns {Promise<string>}
 */
export async function generate(client, prompt) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) {
    throw new Error(
      `generate(): model "${MODEL}" returned no text content (stop_reason: ${response.stop_reason}). ` +
        'This usually means a refusal or an empty response — check response.stop_details if stop_reason is "refusal".'
    );
  }
  return text;
}
