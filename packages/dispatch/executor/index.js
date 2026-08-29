/**
 * BATON dispatch — executor/index.js
 *
 * The provider execution engine (CLAUDE-HANDOFF-BLOCKERS.md "Blocker 1").
 * `executeBatch()` is the one function the dispatcher (a later blocker)
 * depends on: given a RouteDecision (route-contracts.js) and a batch of
 * task items, execute the batch against the selected provider and return
 * an outcome shaped for execution-contracts.js's `createLedgerEvent()`.
 *
 * All six providers are registered behind the same adapter shape
 * (`{ createClient, call, classify, defaultModel }`), so `executeBatch()`
 * has no provider-specific branching in it — it works identically for
 * `providerName: 'anthropic'`, `'openai'`, `'groq'`, `'cerebras'`,
 * `'gemini'`, and `'openrouter'`, and a caller retrying against
 * `routeDecision.fallbackProviders[0]` just calls it again with a
 * different `providerName`/`client`, no special-casing required. Building
 * that retry loop itself is the dispatcher's job (later blocker) — this
 * module only has to make the retry trivial.
 */

import { createLedgerEvent } from '../execution-contracts.js';
import { EXECUTION_STATUS } from './errors.js';
import { createClient as createAnthropicClient, callAnthropic, classifyAnthropicError, DEFAULT_MODEL as ANTHROPIC_DEFAULT_MODEL, PROVIDER_NAME as ANTHROPIC_PROVIDER } from './anthropic.js';
import { createClient as createOpenAIClient, callOpenAI, classifyOpenAIError, DEFAULT_MODEL as OPENAI_DEFAULT_MODEL, PROVIDER_NAME as OPENAI_PROVIDER } from './openai.js';
import { createClient as createGroqClient, callGroq, classifyGroqError, DEFAULT_MODEL as GROQ_DEFAULT_MODEL, PROVIDER_NAME as GROQ_PROVIDER } from './groq.js';
import { createClient as createCerebrasClient, callCerebras, classifyCerebrasError, DEFAULT_MODEL as CEREBRAS_DEFAULT_MODEL, PROVIDER_NAME as CEREBRAS_PROVIDER } from './cerebras.js';
import { createClient as createGeminiClient, callGemini, classifyGeminiError, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL, PROVIDER_NAME as GEMINI_PROVIDER } from './gemini.js';
import { createClient as createOpenRouterClient, callOpenRouter, classifyOpenRouterError, DEFAULT_MODEL as OPENROUTER_DEFAULT_MODEL, PROVIDER_NAME as OPENROUTER_PROVIDER } from './openrouter.js';

export { EXECUTION_STATUS };

/** Registry of provider execution adapters. Adding a provider means adding
 * one entry here — `executeBatch()` itself never changes. */
const PROVIDER_ADAPTERS = {
  [ANTHROPIC_PROVIDER]: {
    createClient: createAnthropicClient,
    call: callAnthropic,
    classify: classifyAnthropicError,
    defaultModel: ANTHROPIC_DEFAULT_MODEL
  },
  [OPENAI_PROVIDER]: {
    createClient: createOpenAIClient,
    call: callOpenAI,
    classify: classifyOpenAIError,
    defaultModel: OPENAI_DEFAULT_MODEL
  },
  [GROQ_PROVIDER]: {
    createClient: createGroqClient,
    call: callGroq,
    classify: classifyGroqError,
    defaultModel: GROQ_DEFAULT_MODEL
  },
  [CEREBRAS_PROVIDER]: {
    createClient: createCerebrasClient,
    call: callCerebras,
    classify: classifyCerebrasError,
    defaultModel: CEREBRAS_DEFAULT_MODEL
  },
  [GEMINI_PROVIDER]: {
    createClient: createGeminiClient,
    call: callGemini,
    classify: classifyGeminiError,
    defaultModel: GEMINI_DEFAULT_MODEL
  },
  [OPENROUTER_PROVIDER]: {
    createClient: createOpenRouterClient,
    call: callOpenRouter,
    classify: classifyOpenRouterError,
    defaultModel: OPENROUTER_DEFAULT_MODEL
  }
};

export function getProviderAdapter(providerName) {
  const adapter = PROVIDER_ADAPTERS[(providerName ?? '').toLowerCase()];
  if (!adapter) {
    throw new Error(
      `executeBatch(): no execution adapter registered for provider "${providerName}". ` +
        `Registered providers: ${Object.keys(PROVIDER_ADAPTERS).join(', ')}`
    );
  }
  return adapter;
}

/**
 * Flatten a batch of task items (`{ id, content }[]`, matching
 * route-contracts.js `buildTaskRequest()`'s `items` shape) into a single
 * prompt. This is intentionally the simplest thing that works: one user
 * turn listing every item in the batch, delimited so the model can tell
 * them apart. Fresh-context execution (IMPLEMENTATION-PLAN.md Sprint 5)
 * means each batch gets exactly one such call, with no prior turns.
 */
export function buildPromptFromBatch(routeDecision, batch) {
  const items = Array.isArray(batch) ? batch : [];
  const header = `Task kind: ${routeDecision?.reasoning?.taskKind ?? 'document-analysis'}. Process each item below independently.`;
  const body = items
    .map((item, idx) => {
      const id = item?.id ?? `item-${idx}`;
      const content = typeof item?.content === 'string' ? item.content : JSON.stringify(item?.content ?? item ?? '');
      return `--- item:${id} ---\n${content}`;
    })
    .join('\n\n');
  return `${header}\n\n${body}`;
}

/**
 * Execute one batch against the provider named in `providerName`.
 *
 * @param {object} routeDecision - a route-contracts.js RouteDecision (or any
 *   object carrying at least `primaryProvider`/`batchPlan` — not required to
 *   call this, only used for prompt context and ledger linkage).
 * @param {Array<{id?: string, content?: string}>} batch - the items this
 *   batch applies to (a slice of the task's `items`, matching one
 *   `batchPlan[].itemIds` entry).
 * @param {{ client?: object, providerName: string, model?: string,
 *   maxTokens?: number, timeoutMs?: number }} options - `client` is the
 *   injected SDK client (a real `Anthropic`/`OpenAI` instance, or a test
 *   stub); when omitted, a real client is constructed from the ambient
 *   environment via the adapter's `createClient()`. `providerName` selects
 *   which adapter handles the call — REQUIRED, since it is what makes
 *   retrying against a fallback provider just a different argument rather
 *   than a different code path.
 * @returns {Promise<{
 *   status: 'success'|'quota_exceeded'|'timeout'|'error',
 *   actualTokens: number,
 *   latencyMs: number,
 *   output: string|null,
 *   errorDetail: string|null,
 *   errorClass: string|null,
 *   provider: string
 * }>}
 */
export async function executeBatch(routeDecision, batch, options = {}) {
  const { client, providerName, model, maxTokens, timeoutMs } = options;

  if (!providerName) {
    throw new Error('executeBatch(): options.providerName is required (e.g. "anthropic" or "openai")');
  }

  const adapter = getProviderAdapter(providerName);
  const resolvedClient = client ?? adapter.createClient();
  const prompt = buildPromptFromBatch(routeDecision, batch);

  const startedAt = Date.now();
  try {
    const { text, actualTokens } = await adapter.call(resolvedClient, prompt, {
      model: model ?? adapter.defaultModel,
      maxTokens: maxTokens ?? 4096,
      timeoutMs
    });

    return {
      status: EXECUTION_STATUS.SUCCESS,
      actualTokens,
      latencyMs: Date.now() - startedAt,
      output: text,
      errorDetail: null,
      errorClass: null,
      provider: providerName
    };
  } catch (err) {
    const { status, errorClass, errorDetail } = adapter.classify(err);

    return {
      // actualTokens is 0 here because no usable response was ever
      // received — it must NEVER fall back to the batch's predicted
      // `expectedTokens`. A failed call has no real measurement, and
      // reporting the prediction as if it were the measurement would
      // corrupt the very prediction-accuracy signal this product exists
      // to produce.
      status,
      actualTokens: 0,
      latencyMs: Date.now() - startedAt,
      output: null,
      errorDetail,
      errorClass,
      provider: providerName
    };
  }
}

/**
 * Given a fallback chain and the providers already attempted, return the
 * next provider to retry against — or `null` if the chain is exhausted.
 * This is the "trivial to call again" seam requirement 6 asks for: it does
 * NOT retry anything itself (that orchestration loop is the dispatcher's
 * job, a later blocker), it just removes the need for a caller to
 * special-case "what's the next provider" when a batch fails.
 */
export function pickNextFallbackProvider(routeDecision, attemptedProviders = []) {
  const attempted = new Set([routeDecision?.primaryProvider, ...attemptedProviders].filter(Boolean));
  const chain = Array.isArray(routeDecision?.fallbackProviders) ? routeDecision.fallbackProviders : [];
  return chain.find((provider) => !attempted.has(provider)) ?? null;
}

/**
 * Build the ledger event for one batch's execution outcome, via
 * execution-contracts.js's `createLedgerEvent()`. Defaults the event type
 * to 'task-completed' on success and 'task-failed' on any failure
 * (quota_exceeded / timeout / error alike — they are still told apart via
 * `payload.status` / `payload.errorClass`, which is what the reputation
 * loop actually branches on); pass `eventType: 'task-executed'` explicitly
 * to log the raw attempt instead, e.g. before a later verification step
 * decides completion.
 *
 * `predictedTokens` and `actualTokens` are always both present and always
 * sourced from two different places — the route decision's batch plan
 * (a prediction) and the outcome's measured usage (the real number) — so
 * a later prediction-accuracy step can compare them without either one
 * having silently become the other.
 */
export function buildExecutionLedgerEvent(routeDecision, outcome, { batchIndex = null, eventType, taskId, provider } = {}) {
  const predictedTokens =
    batchIndex != null && Array.isArray(routeDecision?.batchPlan)
      ? routeDecision.batchPlan[batchIndex]?.expectedTokens ?? null
      : null;

  const resolvedEventType = eventType ?? (outcome.status === EXECUTION_STATUS.SUCCESS ? 'task-completed' : 'task-failed');

  return createLedgerEvent({
    eventType: resolvedEventType,
    taskId: taskId ?? routeDecision?.taskId,
    provider: provider ?? outcome.provider ?? routeDecision?.primaryProvider ?? null,
    routeId: routeDecision?.decisionId ?? null,
    payload: {
      batchIndex,
      status: outcome.status,
      errorClass: outcome.errorClass ?? null,
      errorDetail: outcome.errorDetail ?? null,
      predictedTokens,
      actualTokens: outcome.actualTokens,
      latencyMs: outcome.latencyMs
    }
  });
}
