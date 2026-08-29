/**
 * bench/degradation/runner.js — resumable, quota-aware execution of a
 * campaign plan built by campaign.js.
 *
 * Per-cell wiring, real: intake (`route-contracts.js`'s `buildTaskRequest`/
 * `estimateProviderFit`) -> route (`buildRouteDecision`) -> execute
 * (`executor/index.js`'s `executeBatch()`, with the structured claim
 * envelope wired in via `executor/envelope.js`'s `buildEnvelopePrompt`,
 * exactly as `tests/merge.test.js`'s own integration test already proves
 * works) -> score + log (`merge/index.js`'s `mergeRoute()`, which is the
 * single call that both scores the batch via `quality/score.js` AND
 * appends the `'batch-quality-scored'` ledger event when `options.ledgerPath`
 * is given — see that module's docstring). This file adds exactly one more
 * ledger write on top of that: a `'campaign-cell-completed'` event per cell,
 * carrying the fields a later curve-fit needs that aren't otherwise
 * co-located (batchSize, repetition, the raw execution status).
 *
 * NOTE on the consistency half of the score for a single-cell run: each
 * campaign cell executes exactly ONE batch (there is no second, peer batch
 * within a cell to cross-check against) — so `mergeRoute()`'s
 * `crossCheckBatches()` always finds every claim `unmatched`, and
 * `quality/score.js`'s `scoreConsistency()` defaults that to a neutral
 * score of 1 (no comparable claims -> no penalty, no credit, per that
 * module's own documented contract). The recorded `combinedScore` for a
 * campaign cell is therefore effectively bounded to
 * `[0.65, 1.0]` (`0.35 * deterministicScore + 0.65 * 1`) rather than the
 * full `[0, 1]` a multi-batch route can reach. This is not a bug in this
 * runner — it is the honest consequence of measuring one provider's
 * single-batch degradation rather than cross-batch agreement — and it is
 * documented here so a later reader of the ledger does not mistake a
 * compressed range for a miscalibrated metric.
 */

import { buildTaskRequest, buildRouteDecision, estimateProviderFit } from '../../packages/dispatch/route-contracts.js';
import { getProviderProfile } from '../../packages/dispatch/provider-profiles.js';
import { executeBatch, buildPromptFromBatch } from '../../packages/dispatch/executor/index.js';
import { buildEnvelopePrompt } from '../../packages/dispatch/executor/envelope.js';
import { mergeRoute } from '../../packages/dispatch/merge/index.js';
import { appendEvent, readEvents } from '../../packages/dispatch/ledger/store.js';
import { createLedgerEvent } from '../../packages/dispatch/execution-contracts.js';

/** Real, promise-based delay. Injectable (see `runCampaign`'s `sleep`
 * option) so a test can exercise the pacing code path without a test suite
 * actually waiting on real wall-clock time. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimum milliseconds between two calls to the same provider, derived from
 * that provider's own published `rateLimits.rpm` (provider-profiles.js).
 * Fixed-delay pacing, not a full token bucket: simpler to reason about and
 * sufficient here, since this runner already processes one cell at a time
 * (never concurrent calls to the same provider) — a token bucket would only
 * pay for itself under bursty/concurrent request patterns, which this
 * runner does not have. A provider with no published `rpm` (anthropic/
 * openai here — paid tiers, no quota ceiling recorded in this project) is
 * paced at 0ms, i.e. not paced at all.
 *
 * @param {string} providerName
 * @returns {number}
 */
export function minIntervalMsFor(providerName) {
  const profile = getProviderProfile(providerName);
  const rpm = profile?.rateLimits?.rpm;
  if (!Number.isFinite(rpm) || rpm <= 0) return 0;
  return Math.ceil(60000 / rpm);
}

/** Has this exact cell already been recorded in the ledger? The cell's
 * `taskId` is deterministic (campaign.js's `buildCampaignPlan()`), so this
 * is a plain `readEvents()` filter — no bespoke matching logic needed. This
 * IS the resumability mechanism: the ledger itself is the checkpoint,
 * consistent with this project's "the log is the ground truth, no separate
 * mutable state file" convention (see `ledger/reputation.js`). */
function isCellAlreadyCompleted(ledgerPath, taskId) {
  const { events } = readEvents(ledgerPath, { eventType: 'campaign-cell-completed', taskId });
  return events.length > 0;
}

/**
 * Execute ONE campaign cell end to end: build the task/route/batch, execute
 * against the given client with the envelope prompt wired in, score +
 * ledger-log the batch via `mergeRoute()`, then append this cell's own
 * `'campaign-cell-completed'` event.
 *
 * @param {{ provider: string, batchSize: number, repetition: number, taskId: string, batchContent: Array<{id:string, content:string}> }} cell
 * @param {{ client?: object, ledgerPath?: string }} options - `client` is
 *   the injected SDK client (real or a test stub, same contract as
 *   `executor/index.js`'s `executeBatch()`); omitted, a real client is
 *   constructed from the ambient environment by that provider's adapter.
 *   `ledgerPath`, when given, is where both the `'batch-quality-scored'`
 *   event (via `mergeRoute()`) and this cell's own
 *   `'campaign-cell-completed'` event are appended; omitted, this function
 *   does no ledger I/O (matching `mergeRoute()`'s own optional-ledger
 *   convention).
 * @returns {Promise<{ provider: string, batchSize: number, repetition: number, contextRatio: number, qualityScore: number|null, latencyMs: number, actualTokens: number, status: string, timestamp: string }>}
 */
export async function runCampaignCell(cell, options = {}) {
  const { client, ledgerPath } = options;
  const { provider, batchSize, repetition, taskId, batchContent } = cell;

  const providerProfile = getProviderProfile(provider);
  const task = buildTaskRequest({ taskId, kind: 'document-analysis', items: batchContent });
  const fit = estimateProviderFit(task, providerProfile);

  const routeDecision = buildRouteDecision({
    taskId,
    primaryProvider: provider,
    batchPlan: [{ batchIndex: 0, itemIds: batchContent.map((item) => item.id), expectedTokens: fit.estimatedTokens }],
    reasoning: {
      taskKind: task.kind,
      selectedReason: 'degradation-measurement-campaign',
      alternativeProviders: [],
      rejectedReasons: {}
    }
  });

  // Step 1's structured envelope prompt, genuinely wired into execution —
  // same seam `tests/merge.test.js`'s own integration test uses.
  const buildPrompt = (rd, batch) => buildEnvelopePrompt(buildPromptFromBatch(rd, batch), { kind: rd.reasoning.taskKind });

  const outcome = await executeBatch(routeDecision, batchContent, { client, providerName: provider, buildPrompt });

  // Score + log the batch in one call. A single-batch "route" — see this
  // file's header note on why the consistency half is always neutral here.
  const mergeResult = mergeRoute(
    routeDecision,
    [{ provider, batchIndex: 0, outcome, batch: batchContent, originalItems: batchContent, contextRatio: fit.contextRatio }],
    { ledgerPath, taskId }
  );

  const qualityScoreEntry = mergeResult.qualityScores.find((q) => q.provider === provider && q.batchIndex === 0) ?? null;
  const qualityScore = qualityScoreEntry ? qualityScoreEntry.combinedScore : null;

  const result = {
    provider,
    batchSize,
    repetition,
    contextRatio: Number.isFinite(fit.contextRatio) ? fit.contextRatio : null,
    qualityScore,
    latencyMs: outcome.latencyMs,
    actualTokens: outcome.actualTokens,
    status: outcome.status,
    timestamp: new Date().toISOString()
  };

  if (ledgerPath) {
    const event = createLedgerEvent({
      eventType: 'campaign-cell-completed',
      taskId,
      provider,
      routeId: routeDecision.decisionId,
      payload: {
        batchSize,
        repetition,
        contextRatio: result.contextRatio,
        qualityScore: result.qualityScore,
        latencyMs: result.latencyMs,
        actualTokens: result.actualTokens,
        status: result.status,
        mergeStatus: mergeResult.status,
        errorClass: outcome.errorClass ?? null
      },
      timestamp: result.timestamp
    });
    appendEvent(ledgerPath, event);
  }

  return result;
}

/**
 * Run every cell in `plan`, in order, with resumability and quota
 * awareness.
 *
 * Resumability: before running a cell, check whether it is already in the
 * ledger (`isCellAlreadyCompleted`) — if so, skip it (reported via
 * `onProgress`, never silently) rather than re-running and duplicating the
 * measurement.
 *
 * Quota awareness: paced per provider via `minIntervalMsFor()` before every
 * call. If a cell for a given provider comes back `status: 'quota_exceeded'`,
 * that provider is marked halted for the REST OF THIS RUN — every remaining
 * cell for it is skipped (reported via `onProgress`), never retried in a
 * busy loop, while cells for every other provider continue normally. The
 * halt is scoped to this one `runCampaign()` call, not persisted: a fresh
 * invocation (e.g. after the provider's quota window resets) is free to
 * retry it, and the ledger's resumability check will correctly skip only
 * the cells that cell already completed before the halt.
 *
 * @param {Array<{ provider: string, batchSize: number, repetition: number, taskId: string, batchContent: Array }>} plan
 * @param {{
 *   getClient: (provider: string) => object,
 *   ledgerPath?: string,
 *   onProgress?: (cell: object, result: object) => void,
 *   sleep?: (ms: number) => Promise<void>
 * }} options
 * @returns {Promise<{ results: object[], haltedProviders: string[], skipped: Array<{ cell: object, reason: string }> }>}
 */
export async function runCampaign(plan, options = {}) {
  const { getClient, ledgerPath, onProgress, sleep = defaultSleep } = options;
  if (typeof getClient !== 'function') {
    throw new Error('runCampaign(): options.getClient is required (a function provider -> client)');
  }

  const cells = Array.isArray(plan) ? plan : [];
  const results = [];
  const skipped = [];
  const haltedProviders = new Set();
  const lastCallAt = new Map();

  for (const cell of cells) {
    const { provider, taskId } = cell;

    if (haltedProviders.has(provider)) {
      const reason = `provider "${provider}" halted earlier this run (quota_exceeded) — not retried in this run`;
      skipped.push({ cell, reason });
      onProgress?.(cell, { skipped: true, reason });
      continue;
    }

    if (ledgerPath && isCellAlreadyCompleted(ledgerPath, taskId)) {
      const reason = `already completed (found in ledger) — resumed, not re-run`;
      skipped.push({ cell, reason });
      onProgress?.(cell, { skipped: true, reason });
      continue;
    }

    const minInterval = minIntervalMsFor(provider);
    if (minInterval > 0) {
      const last = lastCallAt.get(provider);
      if (last != null) {
        const elapsed = Date.now() - last;
        if (elapsed < minInterval) {
          await sleep(minInterval - elapsed);
        }
      }
    }

    const client = getClient(provider);
    const result = await runCampaignCell(cell, { client, ledgerPath });
    lastCallAt.set(provider, Date.now());
    results.push(result);

    if (result.status === 'quota_exceeded') {
      haltedProviders.add(provider);
    }

    onProgress?.(cell, result);
  }

  return { results, haltedProviders: [...haltedProviders], skipped };
}
