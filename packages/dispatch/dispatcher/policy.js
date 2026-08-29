/**
 * BATON dispatch — dispatcher/policy.js
 *
 * Layer 3 (PRODUCT-ARCHITECTURE.md): the actual decision logic. Everything
 * this file depends on already exists and is deliberately NOT reimplemented
 * here — this module is glue + judgment calls on top of:
 *   - route-contracts.js:      buildTaskRequest, estimateProviderFit,
 *                               planBatches, buildRouteDecision
 *   - provider-profiles.js:    getProviderProfile, rankProviders
 *   - ledger/store.js:         computePoolState (real, current pool state —
 *                               never a static number)
 *   - ledger/reputation.js:    computeTrustScore (the recency-weighted
 *                               formula; see that file's header for why)
 *   - executor/index.js:       pickNextFallbackProvider, error classes from
 *                               executor/errors.js's EXECUTION_STATUS
 *
 * `decideRoute()` returns exactly one of three distinguishable shapes —
 * never a thrown error for "no safe route", never a bare null:
 *   - an APPROVED RouteDecision  (`approved: true`,  route-contracts.js's
 *     buildRouteDecision() shape, extended with `approved`)
 *   - a REJECTED decision        (`approved: false`, `reason`, `suggestions`)
 *   - (thrown Error is reserved for genuine misuse — e.g. an operator
 *     override with no provider — never for "the policy could not find a
 *     safe route", which is what REJECTED is for)
 * This mirrors BATON's own gate() ACCEPT/REJECT/error discipline, applied
 * at the dispatcher layer.
 *
 * Explicitly OUT OF SCOPE (CLAUDE-HANDOFF-BLOCKERS.md "Blocker 4: Task
 * Quality Prediction" is a separate, later blocker): this file does not
 * build a task-quality classifier. `task.qualityTarget` is taken as given
 * (route-contracts.js's buildTaskRequest() already defaults/normalizes it;
 * analyzeTaskQuality()'s heuristic, if a caller wants it, runs before this
 * function is called, not inside it).
 */

import { buildTaskRequest, estimateProviderFit, planBatches, buildRouteDecision } from '../route-contracts.js';
import { getProviderProfile, rankProviders } from '../provider-profiles.js';
import { createLedgerEvent, buildRouteLedgerEntry } from '../execution-contracts.js';
import { appendEvent, computePoolState } from '../ledger/store.js';
import { computeTrustScore } from '../ledger/reputation.js';
import { pickNextFallbackProvider } from '../executor/index.js';

// ---------------------------------------------------------------------------
// Tunable thresholds — every judgment call the doc left open is named here,
// nowhere buried in branch logic, per CLAUDE-HANDOFF-BLOCKERS.md Blocker 3's
// own complaint ("route selection becomes a black box").
// ---------------------------------------------------------------------------

/**
 * Step 1 shortcut: any agent prediction whose reputation.computeTrustScore()
 * result is strictly above this value is approved immediately, no further
 * deliberation. PRODUCT-ARCHITECTURE.md Layer 3's decision tree literally
 * specifies this ("Is this agent high-reputation (>0.90)? YES -> APPROVE
 * prediction immediately") — the doc leaves *whether* to hardcode a
 * threshold as a judgment call, but it already picked the number, so 0.90
 * is carried over verbatim here rather than replaced with an arbitrary
 * alternative invented for this file.
 */
export const HIGH_CONFIDENCE_TRUST_THRESHOLD = 0.9;

/**
 * Step 2: predicted usage is "comfortably" under budget when it is less
 * than this fraction of the provider's currently remaining quota (from
 * ledger/store.js's computePoolState() — real, replayed-from-the-ledger
 * state, never a cached/static number). PRODUCT-ARCHITECTURE.md Layer 3
 * states this literally as "< 50% of available", so 0.5 is carried over
 * from the doc for the same reason as the threshold above.
 */
export const QUOTA_COMFORTABLE_FRACTION = 0.5;

/**
 * Step 3's multi-objective composite score for choosing between competing
 * agent predictions:
 *   compositeScore = REPUTATION_WEIGHT * trust
 *                   + TOKEN_EFFICIENCY_WEIGHT * (1 - predictedTokens / maxPredictedTokens)
 * 0.7/0.3 is not a new number invented for this file — it reuses the exact
 * split ledger/reputation.js's computeTrustScore() already uses for
 * recent-vs-historical weighting. This codebase already made one considered
 * "how much should the stronger signal count" call; an unrelated ad-hoc
 * ratio here would be a second, unjustified judgment call with no basis to
 * prefer 0.7/0.3 over 0.6/0.4 or 0.8/0.2. Reputation still dominates (a
 * large trust gap wins even against a real token-cost difference), but
 * token efficiency has real pull — enough to flip a decision when the
 * reputation gap is small and the token gap is large. That pull is what
 * makes this "genuine" multi-objective comparison rather than
 * reputation-only with token count as a tiebreaker.
 */
export const REPUTATION_WEIGHT = 0.7;
export const TOKEN_EFFICIENCY_WEIGHT = 0.3;

/**
 * Step 3 only: an agent with zero ledger history (computeTrustScore()
 * returns the `{ trustScore: null }` marker, never a bare number) is
 * neither auto-trusted nor auto-zeroed-out in the composite score — it is
 * treated as a neutral, unproven prior. 0.5 sits below
 * HIGH_CONFIDENCE_TRUST_THRESHOLD (so an unproven agent can never win step
 * 1) but is not automatically outscored by every agent with even a thin
 * track record.
 */
export const UNPROVEN_AGENT_PRIOR_TRUST = 0.5;

/**
 * When an approved agent's own predicted token total diverges from this
 * policy's own route-contracts.estimateProviderFit() estimate by more than
 * this fraction, a warning is attached to `reasoning.warnings`. This is
 * NOT a rejection signal and does not change the routing decision — scoring
 * the agent for the mismatch is Blocker 4 (Task Quality Prediction)
 * territory, explicitly out of scope here. It exists purely so a human
 * reading the decision later sees the discrepancy instead of it being
 * silently absorbed into "expectedTokens" on the batch plan.
 */
export const AGENT_SYSTEM_DIVERGENCE_WARNING_FRACTION = 0.25;

/**
 * Step 5: which executeBatch() outcome statuses/error classes are eligible
 * for an automatic fallback-provider retry, versus which must surface
 * immediately as a hard failure needing operator attention.
 *
 * Eligible (retrying elsewhere plausibly changes the outcome — the failure
 * is about THIS provider/THIS call, not about the batch's content):
 *   - 'quota_exceeded' (RateLimitError): this provider's quota/rate limit,
 *     specifically. A different provider has an entirely separate quota
 *     pool, so retrying there is exactly the point of having a fallback
 *     chain at all.
 *   - 'timeout' (APIConnectionTimeoutError): a transient network/latency
 *     condition against this provider's endpoint. Unrelated to what was in
 *     the batch.
 *   - 'error' + errorClass 'APIConnectionError' (non-timeout connection
 *     failure — DNS, reset, etc.): same reasoning as timeout, a network
 *     condition against this endpoint, not the request content.
 *
 * NOT eligible (surface as a hard failure instead):
 *   - 'error' + errorClass 'AuthenticationError': this process's
 *     CREDENTIALS for the specific provider are bad. A fallback provider
 *     uses different credentials, so a retry there might even succeed —
 *     but silently rerouting around it would mask a standing configuration
 *     problem that will keep failing every future task routed to this
 *     provider, not just this one. An operator needs to see and fix it
 *     once, rather than the system quietly routing all future traffic away
 *     from a broken provider with no alert.
 *   - 'error' + any other errorClass (BadRequestError,
 *     UnprocessableEntityError, InternalServerError, UnknownError, ...):
 *     the default "malformed input" bucket the task brief calls out by
 *     name. The batch content itself is what's wrong (or the request was
 *     shaped incorrectly for this content) — the exact same batch sent to
 *     a fallback provider fails for the exact same reason, so an automatic
 *     retry only burns a second call (and the fallback provider's quota)
 *     for a guaranteed-repeat failure. Surfacing this immediately is also
 *     what lets an operator actually see and fix the real problem instead
 *     of it being retried into invisibility.
 */
const FALLBACK_ELIGIBLE_STATUSES = new Set(['quota_exceeded', 'timeout']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(3) : 'unknown';
}

function describeAgent(p) {
  return {
    agentId: p.agentId,
    provider: p.provider,
    trustScore: p.trustScore,
    confidence: p.confidence,
    predictedTokens: p.predictedTokens
  };
}

/** Look up a provider profile by name from the caller-supplied providerList first, falling back to MODEL_PROFILES. */
function resolveProviderProfile(name, providerList = []) {
  const fromList = Array.isArray(providerList) ? providerList.find((p) => p?.name === name) : null;
  return fromList ?? getProviderProfile(name);
}

/** Rank the remaining providers (excluding the chosen one) as a fallback chain, via provider-profiles.js's existing selector. */
function rankFallbackProviders(task, providerList, excludeProvider) {
  return rankProviders(task, providerList)
    .map((r) => r.provider)
    .filter((name) => name && name !== excludeProvider);
}

/**
 * Chunk a task's items into an index-based batch plan
 * (`{ batchIndex, itemIds, expectedTokens }[]`, route-contracts.js's
 * documented `batchPlan` shape) at a given batch size. Neither
 * estimateProviderFit() nor planBatches() exposes item-level chunking (they
 * only return aggregate batchSize/totalBatches numbers), so this is the one
 * piece of genuinely new batch-math in this file.
 */
function buildBatchPlan(items, batchSize, tokensPerItem) {
  const list = Array.isArray(items) ? items : [];
  const safeBatchSize = Math.max(1, Number(batchSize) || 1);
  const plan = [];

  for (let i = 0; i < list.length; i += safeBatchSize) {
    const slice = list.slice(i, i + safeBatchSize);
    plan.push({
      batchIndex: plan.length,
      itemIds: slice.map((item, idx) => item?.id ?? `item-${i + idx}`),
      expectedTokens: tokensPerItem * slice.length
    });
  }

  if (plan.length === 0) {
    // A task with zero items still gets one placeholder batch so an approved
    // decision never carries an empty batchPlan (executor/dashboard code
    // assumes at least one entry when a route is "approved").
    plan.push({ batchIndex: 0, itemIds: [], expectedTokens: 0 });
  }

  return plan;
}

/**
 * Resolve one agent prediction's trust score via
 * reputation.computeTrustScore() against a caller-supplied lookup. This is
 * the literal integration point requirement 3/6 refer to: policy.js calls
 * the real formula, it does not trust a pre-computed number handed to it.
 *
 * @param {object} prediction - `{ agentId, provider, predictedTokens,
 *   recommendedBatchSize?, confidence? }` (a simplified MVP slice of
 *   PRODUCT-ARCHITECTURE.md's `Prediction` schema).
 * @param {(agentId: string) => Array<{accuracy:number, timestamp?:string}>} [reputationLookup]
 *   Returns this agent's accuracy history (the same shape
 *   computeTrustScore() expects) — typically backed by the ledger, but
 *   deliberately a plain function so tests can inject canned history
 *   without touching a real ledger file. Missing/non-array results are
 *   treated as "no history", never a crash.
 */
function evaluateAgentPrediction(prediction = {}, reputationLookup) {
  const agentId = typeof prediction.agentId === 'string' && prediction.agentId ? prediction.agentId : `agent-${Math.random().toString(36).slice(2, 8)}`;

  let history = [];
  if (typeof reputationLookup === 'function') {
    const looked = reputationLookup(agentId);
    if (Array.isArray(looked)) history = looked;
  }

  const trustResult = computeTrustScore(history);
  const trustScore = typeof trustResult === 'number' ? trustResult : null;
  const trustReason = typeof trustResult === 'number' ? null : trustResult.reason;

  return {
    agentId,
    provider: typeof prediction.provider === 'string' ? prediction.provider : null,
    predictedTokens: Number.isFinite(prediction.predictedTokens) ? prediction.predictedTokens : null,
    recommendedBatchSize: Number.isFinite(prediction.recommendedBatchSize) ? prediction.recommendedBatchSize : null,
    confidence: Number.isFinite(prediction.confidence) ? prediction.confidence : null,
    trustScore,
    trustReason
  };
}

/**
 * Step 2: task-level quota check against the top-ranked provider (independent
 * of any agent prediction). Uses planBatches() — route-contracts.js's
 * quality-ranked, per-provider safe-batch math — for the estimate, and
 * ledger/store.js's computePoolState() for the REAL, current remaining
 * quota (never a static/cached number).
 *
 * `remaining` is only knowable when a provider entry in `providerList`
 * carries a `totalQuota` (operator-configured daily budget — Layer 1's
 * `pools.json.total_quota` is runtime/ops state, not a static provider
 * capability, so it is not baked into provider-profiles.js's
 * MODEL_PROFILES). Without it, computePoolState() reports `remaining: null`
 * and this step conservatively does NOT approve — falling through toward
 * step 3/4 — rather than assuming an unknown quota is safe.
 */
function evaluateQuotaComfort(task, providerList, ledgerPath) {
  const plans = planBatches(task, providerList);
  if (plans.length === 0) {
    return { approved: false, reason: 'no-providers-available', provider: null, fit: null, pool: null };
  }

  const top = plans[0];

  if (!ledgerPath || typeof ledgerPath !== 'string') {
    return { approved: false, reason: 'ledger-path-not-provided', provider: top.provider, fit: top, pool: null };
  }

  const providerProfile = resolveProviderProfile(top.provider, providerList);
  const pool = computePoolState(ledgerPath, top.provider, { totalQuota: providerProfile.totalQuota });

  if (!Number.isFinite(pool.remaining)) {
    return { approved: false, reason: 'quota-unknown', provider: top.provider, fit: top, pool };
  }

  const comfortable = top.estimatedTokens < pool.remaining * QUOTA_COMFORTABLE_FRACTION;
  return { approved: comfortable, reason: comfortable ? 'comfortable' : 'not-comfortable', provider: top.provider, fit: top, pool };
}

/**
 * Step 3: genuine multi-objective comparison between competing agent
 * predictions — reputation-weighted quality fit, not reputation alone (see
 * REPUTATION_WEIGHT/TOKEN_EFFICIENCY_WEIGHT above). Requires at least two
 * usable candidates (a provider name AND a predicted token count); returns
 * `null` otherwise so the caller falls through to step 4.
 *
 * @returns {Array|null} candidates sorted best-first, each carrying its
 *   `compositeScore` — so the caller can build `rejectedReasons` for every
 *   loser, not just report the winner.
 */
function scoreMultiObjective(evaluatedPredictions) {
  const candidates = evaluatedPredictions.filter((p) => Number.isFinite(p.predictedTokens) && p.provider);
  if (candidates.length < 2) return null;

  const maxTokens = Math.max(...candidates.map((p) => p.predictedTokens), 1);

  return candidates
    .map((p) => {
      const normTrust = Number.isFinite(p.trustScore) ? p.trustScore : UNPROVEN_AGENT_PRIOR_TRUST;
      const tokenEfficiency = maxTokens > 0 ? 1 - p.predictedTokens / maxTokens : 1;
      const compositeScore = REPUTATION_WEIGHT * normTrust + TOKEN_EFFICIENCY_WEIGHT * tokenEfficiency;
      return { ...p, tokenEfficiency, compositeScore };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);
}

function buildLoserReasons(winner, losers) {
  const out = {};
  for (const loser of losers) {
    out[loser.agentId] =
      `predicted ${loser.predictedTokens} tokens at trust ${fmt(loser.trustScore)} ` +
      `(composite score ${loser.compositeScore.toFixed(3)}) lost to agent "${winner.agentId}"'s ` +
      `predicted ${winner.predictedTokens} tokens at trust ${fmt(winner.trustScore)} ` +
      `(composite score ${winner.compositeScore.toFixed(3)})`;
  }
  return out;
}

/** Shared builder for an approved decision driven by one winning agent prediction (steps 1 and 3). */
function buildApprovalFromAgent(task, winner, allEvaluated, { providerList, decisionPath, selectedReason, rejectedReasons }) {
  const providerProfile = resolveProviderProfile(winner.provider, providerList);
  const fit = estimateProviderFit(task, providerProfile);

  const batchSize =
    Number.isFinite(winner.recommendedBatchSize) && winner.recommendedBatchSize > 0
      ? Math.min(winner.recommendedBatchSize, providerProfile.maxBatchSize ?? winner.recommendedBatchSize)
      : fit.batchSize;

  const batchPlan = buildBatchPlan(task.items, batchSize, providerProfile.tokensPerItem ?? 2000);
  const fallbackProviders = rankFallbackProviders(task, providerList, winner.provider);

  const warnings = [];
  if (Number.isFinite(winner.predictedTokens) && fit.estimatedTokens > 0) {
    const divergence = Math.abs(winner.predictedTokens - fit.estimatedTokens) / fit.estimatedTokens;
    if (divergence > AGENT_SYSTEM_DIVERGENCE_WARNING_FRACTION) {
      warnings.push(
        `agent "${winner.agentId}"'s predicted ${winner.predictedTokens} tokens diverges ${(divergence * 100).toFixed(0)}% ` +
          `from this policy's own estimate of ${fit.estimatedTokens} — treat with caution`
      );
    }
  }

  const decision = buildRouteDecision({
    taskId: task.taskId,
    primaryProvider: winner.provider,
    batchPlan,
    qualityTarget: task.qualityTarget,
    fallbackProviders,
    operatorOverride: false,
    reasoning: {
      selectedReason,
      alternativeProviders: allEvaluated.filter((p) => p.agentId !== winner.agentId).map((p) => p.provider).filter(Boolean),
      rejectedReasons,
      approved: true,
      decisionPath,
      triggeringAgent: winner.agentId,
      triggeringTrustScore: winner.trustScore,
      triggeringConfidence: winner.confidence,
      consideredAgents: allEvaluated.map(describeAgent),
      warnings,
      qualityEstimate: fit.qualityEstimate,
      systemEstimatedTokens: fit.estimatedTokens
    }
  });
  decision.approved = true;
  return decision;
}

/** Step 2's approval builder: quota-comfortable, no agent prediction involved. */
function buildApprovalFromQuota(task, quotaCheck, allEvaluated, providerList) {
  const { provider: providerName, fit, pool } = quotaCheck;
  const providerProfile = resolveProviderProfile(providerName, providerList);
  const batchPlan = buildBatchPlan(task.items, fit.batchSize, providerProfile.tokensPerItem ?? 2000);
  const fallbackProviders = rankFallbackProviders(task, providerList, providerName);

  const decision = buildRouteDecision({
    taskId: task.taskId,
    primaryProvider: providerName,
    batchPlan,
    qualityTarget: task.qualityTarget,
    fallbackProviders,
    operatorOverride: false,
    reasoning: {
      selectedReason: 'quota-comfortable-buffer',
      alternativeProviders: fallbackProviders,
      rejectedReasons: {},
      approved: true,
      decisionPath: 'step-2-quota-buffer',
      // Explicit, not silent — requirement 2's own wording.
      warnings: ['risky if burn rate changes'],
      quota: {
        provider: providerName,
        remaining: pool.remaining,
        estimatedTokens: fit.estimatedTokens,
        comfortableFraction: QUOTA_COMFORTABLE_FRACTION,
        actualFraction: pool.remaining > 0 ? Number((fit.estimatedTokens / pool.remaining).toFixed(4)) : null
      },
      consideredAgents: allEvaluated.map(describeAgent),
      qualityEstimate: fit.qualityEstimate,
      systemEstimatedTokens: fit.estimatedTokens
    }
  });
  decision.approved = true;
  return decision;
}

/**
 * Step 4: explicit, structured rejection — never a thrown error, never
 * null. Matches PRODUCT-ARCHITECTURE.md's own worked rejection example
 * shape (`{ approved: false, reason, suggestions }`).
 */
function buildRejection(task, evaluatedPredictions, quotaCheck) {
  const maxConfidence = evaluatedPredictions.reduce((max, p) => Math.max(max, Number.isFinite(p.confidence) ? p.confidence : 0), 0);
  const quotaReason = quotaCheck?.reason ?? 'quota-unknown';

  const suggestions = [
    'Wait for quota to refresh before retrying',
    quotaCheck?.provider ? `Use a fallback provider away from ${quotaCheck.provider}` : 'Use a fallback provider',
    'Reduce task scope so predicted usage fits comfortably under available quota'
  ];

  const rejectedReasons = {};
  for (const p of evaluatedPredictions) {
    rejectedReasons[p.agentId] =
      `trust score ${fmt(p.trustScore)} did not clear the high-confidence threshold (${HIGH_CONFIDENCE_TRUST_THRESHOLD}), ` +
      `and predicted usage was not comfortably under available quota (${quotaReason})`;
  }

  return {
    approved: false,
    decisionId: `route-reject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId: task.taskId,
    decidedAt: new Date().toISOString(),
    qualityTarget: task.qualityTarget,
    reason: `No agent confident enough (max ${maxConfidence.toFixed(2)}) + insufficient quota buffer`,
    suggestions,
    reasoning: {
      selectedReason: 'no-safe-route',
      decisionPath: 'step-4-rejection',
      alternativeProviders: evaluatedPredictions.map((p) => p.provider).filter(Boolean),
      rejectedReasons,
      approved: false,
      maxConfidence,
      quotaCheck: quotaCheck ? { provider: quotaCheck.provider ?? null, reason: quotaCheck.reason } : null,
      consideredAgents: evaluatedPredictions.map(describeAgent)
    },
    externalRef: task.externalRef ?? null
  };
}

/**
 * Operator override: bypasses steps 1-4 entirely. Still produces a real,
 * fully-shaped RouteDecision (via route-contracts.js's buildRouteDecision(),
 * which already has an `operatorOverride` field for exactly this) — the
 * override is never a different, thinner shape than an automated decision,
 * only distinguishably FLAGGED as one, both on the object itself
 * (`operatorOverride: true`) and in the ledger event `logRouteDecision()`
 * appends below.
 */
function buildOverrideDecision(task, override, { providerList, ledgerPath }) {
  if (!override || typeof override.provider !== 'string' || !override.provider) {
    throw new Error('decideRoute: operatorOverride.provider is required (a caller-forced provider name)');
  }

  const providerProfile = resolveProviderProfile(override.provider, providerList);
  const fit = estimateProviderFit(task, providerProfile);
  const batchSize = Number.isFinite(override.batchSize) && override.batchSize > 0 ? override.batchSize : fit.batchSize;
  const batchPlan = buildBatchPlan(task.items, batchSize, providerProfile.tokensPerItem ?? 2000);
  const fallbackProviders = rankFallbackProviders(task, providerList, override.provider);

  const decision = buildRouteDecision({
    taskId: task.taskId,
    primaryProvider: override.provider,
    batchPlan,
    qualityTarget: Number.isFinite(override.qualityTarget) ? override.qualityTarget : task.qualityTarget,
    fallbackProviders,
    operatorOverride: true,
    reasoning: {
      selectedReason: 'operator-override',
      alternativeProviders: fallbackProviders,
      rejectedReasons: {},
      approved: true,
      decisionPath: 'operator-override',
      overrideReason: override.reason ?? null,
      warnings: ['operator override bypasses policy evaluation entirely — not verified against reputation or quota']
    }
  });
  decision.approved = true;

  logRouteDecision(ledgerPath, task, decision, { operatorOverride: true });
  return decision;
}

/**
 * Appends one 'task-routed' ledger event per decision — the only existing
 * LEDGER_EVENT_TYPES value that fits "a route decision was made" (checked
 * against the full enum before reusing it; see execution-contracts.js).
 * `payload.operatorOverride` is always present as an explicit boolean
 * (true only on the override path), never merely absent for a normal
 * decision — so a normal automated decision is never indistinguishable
 * from an override by the field simply not being there.
 *
 * Best-effort: a missing/falsy `ledgerPath` is not an error (matches
 * ledger/store.js's own "no ledger yet is not a failure" contract) — it
 * just means this decision isn't durably logged, which lets decideRoute()
 * stay usable in pure unit tests that never touch a real file.
 */
function logRouteDecision(ledgerPath, task, decision, meta) {
  if (!ledgerPath || typeof ledgerPath !== 'string') return null;

  const event = createLedgerEvent({
    eventType: 'task-routed',
    taskId: task.taskId,
    provider: decision.primaryProvider ?? null,
    routeId: decision.decisionId ?? null,
    payload: {
      approved: Boolean(decision.approved),
      operatorOverride: Boolean(meta?.operatorOverride),
      decisionPath: decision.reasoning?.decisionPath ?? null,
      reason: decision.reason ?? decision.reasoning?.selectedReason ?? null
    }
  });

  return appendEvent(ledgerPath, event);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The dispatcher's actual decision logic (CLAUDE-HANDOFF-BLOCKERS.md
 * "Blocker 3"). Walks PRODUCT-ARCHITECTURE.md Layer 3's decision tree as
 * four ordered gates, returning the first that resolves:
 *
 *   1. High-reputation shortcut       (trustScore > HIGH_CONFIDENCE_TRUST_THRESHOLD)
 *   2. Quota-comfortable buffer       (estimatedTokens < remaining * QUOTA_COMFORTABLE_FRACTION)
 *   3. Multi-agent weighted comparison (>= 2 usable predictions)
 *   4. Explicit structured rejection  (nothing above resolved)
 *
 * Design decision, stated explicitly: PRODUCT-ARCHITECTURE.md's own step 4
 * ("Fallback: use most-available pool, argmax(available_tokens)") is
 * deliberately NOT implemented as a silent default here. This project's
 * own risk framing for Blocker 3 is "route selection becomes a black box"
 * — a silent best-effort fallback that always approves *something* is
 * exactly that black box. Instead, when nothing clears steps 1-3, the
 * function returns the doc's own worked REJECTION example
 * (`{ approved: false, reason, suggestions }`) so a caller always gets an
 * explainable, structured "no" instead of an unexplained "yes."
 *
 * @param {object} taskInput - anything route-contracts.js's buildTaskRequest()
 *   accepts; normalized internally.
 * @param {object} [options]
 * @param {Array<object>} [options.providerList] - provider profile objects
 *   (provider-profiles.js MODEL_PROFILES shape: name, contextWindow,
 *   tokensPerItem, safeContextRatio, maxBatchSize, qualityCurve), optionally
 *   each carrying a `totalQuota` (operator-configured daily budget) for step
 *   2's quota check to use.
 * @param {Array<object>} [options.agentPredictions] - `{ agentId, provider,
 *   predictedTokens, recommendedBatchSize?, confidence? }[]`.
 * @param {(agentId: string) => Array<{accuracy:number, timestamp?:string}>} [options.reputationLookup] -
 *   returns one agent's accuracy history for computeTrustScore(); omitted
 *   agents are treated as having no history.
 * @param {string} [options.ledgerPath] - real ledger file for
 *   computePoolState() (step 2) and for logging this decision as a
 *   'task-routed' event. Optional: without it, step 2 cannot confidently
 *   approve (falls through) and decisions simply aren't logged.
 * @param {{ provider: string, batchSize?: number, qualityTarget?: number,
 *   reason?: string }} [options.operatorOverride] - when present, bypasses
 *   steps 1-4 entirely (see buildOverrideDecision above). `provider` is
 *   required.
 * @returns {object} an approved RouteDecision (`approved: true`) or a
 *   structured rejection (`approved: false, reason, suggestions`). Never
 *   null, never thrown, for "no safe route" — see file header.
 */
export function decideRoute(taskInput, options = {}) {
  const { providerList = [], agentPredictions = [], reputationLookup, ledgerPath, operatorOverride = null } = options;

  const task = buildTaskRequest(taskInput);

  if (operatorOverride) {
    return buildOverrideDecision(task, operatorOverride, { providerList, ledgerPath });
  }

  const evaluatedPredictions = (Array.isArray(agentPredictions) ? agentPredictions : []).map((p) => evaluateAgentPrediction(p, reputationLookup));

  // ---- Step 1: high-reputation shortcut ----
  // A candidate must also carry a usable provider recommendation — a
  // trustworthy agent with no provider named isn't actionable, so it falls
  // through toward the later steps rather than being force-fit here.
  const highReputationCandidates = evaluatedPredictions
    .filter((p) => Number.isFinite(p.trustScore) && p.trustScore > HIGH_CONFIDENCE_TRUST_THRESHOLD && p.provider)
    .sort((a, b) => b.trustScore - a.trustScore);

  if (highReputationCandidates.length > 0) {
    const winner = highReputationCandidates[0];
    const decision = buildApprovalFromAgent(task, winner, evaluatedPredictions, {
      providerList,
      decisionPath: 'step-1-high-reputation-shortcut',
      selectedReason: 'high-reputation-shortcut',
      // "Without further deliberation" (requirement 1) — alternatives were
      // never weighed against each other, so there is nothing to reject.
      rejectedReasons: {}
    });
    logRouteDecision(ledgerPath, task, decision, { operatorOverride: false });
    return decision;
  }

  // ---- Step 2: quota-comfortable buffer (task-level, not agent-dependent) ----
  const quotaCheck = evaluateQuotaComfort(task, providerList, ledgerPath);
  if (quotaCheck.approved) {
    const decision = buildApprovalFromQuota(task, quotaCheck, evaluatedPredictions, providerList);
    logRouteDecision(ledgerPath, task, decision, { operatorOverride: false });
    return decision;
  }

  // ---- Step 3: multi-agent weighted comparison ----
  const scored = scoreMultiObjective(evaluatedPredictions);
  if (scored) {
    const [winner, ...losers] = scored;
    const decision = buildApprovalFromAgent(task, winner, evaluatedPredictions, {
      providerList,
      decisionPath: 'step-3-multi-agent-comparison',
      selectedReason: 'multi-agent-weighted-comparison',
      rejectedReasons: buildLoserReasons(winner, losers)
    });
    logRouteDecision(ledgerPath, task, decision, { operatorOverride: false });
    return decision;
  }

  // ---- Step 4: explicit structured rejection ----
  const decision = buildRejection(task, evaluatedPredictions, quotaCheck);
  logRouteDecision(ledgerPath, task, decision, { operatorOverride: false });
  return decision;
}

/**
 * Step 5: should an executeBatch() failure trigger a fallback-provider
 * retry? See FALLBACK_ELIGIBLE_STATUSES above for the full reasoning.
 * Pure predicate — does not itself retry anything.
 */
export function shouldRetryOnFallback(outcome) {
  if (!outcome || typeof outcome !== 'object') return false;
  if (FALLBACK_ELIGIBLE_STATUSES.has(outcome.status)) return true;
  // Non-timeout connection failures are the same "environmental, not
  // content-related" bucket as a timeout — see FALLBACK_ELIGIBLE_STATUSES.
  if (outcome.status === 'error' && outcome.errorClass === 'APIConnectionError') return true;
  return false;
}

/**
 * Step 5, full decision: combines shouldRetryOnFallback() with
 * executor/index.js's pickNextFallbackProvider() (the "trivial to call
 * again" seam that module already built) to decide both WHETHER to retry
 * and, if so, WHICH provider to retry against next.
 *
 * @param {object} routeDecision - the RouteDecision the failed batch ran
 *   under (carries `primaryProvider`/`fallbackProviders`).
 * @param {object} outcome - an executeBatch() result (`status`, `errorClass`, ...).
 * @param {string[]} [attemptedProviders] - providers already tried for this
 *   batch, so the fallback chain isn't retried into a loop.
 * @returns {{ retry: boolean, nextProvider: string|null, reason: string }}
 */
export function decideFallback(routeDecision, outcome, attemptedProviders = []) {
  const retry = shouldRetryOnFallback(outcome);
  const nextProvider = retry ? pickNextFallbackProvider(routeDecision, attemptedProviders) : null;
  const errorTag = outcome?.errorClass ? ` (${outcome.errorClass})` : '';

  let reason;
  if (retry && nextProvider) {
    reason = `outcome status "${outcome.status}"${errorTag} is environmental/provider-side, not batch-content-related — retrying on "${nextProvider}"`;
  } else if (retry) {
    reason = `outcome status "${outcome.status}"${errorTag} is retriable but the fallback chain is exhausted`;
  } else if (outcome?.errorClass === 'AuthenticationError') {
    reason = `outcome status "${outcome?.status}" (AuthenticationError) is not retried automatically — credentials need operator attention; silently rerouting would mask a standing configuration problem`;
  } else {
    reason = `outcome status "${outcome?.status}"${errorTag} is not retried automatically — the same batch content would fail identically on any provider`;
  }

  return { retry, nextProvider, reason };
}

/**
 * Requirement 6 / dashboard integration: map any decideRoute() output
 * (approved via step 1/2/3/override, or rejected via step 4) into
 * execution-contracts.js's buildRouteLedgerEntry() shape, so it can be fed
 * straight into buildDashboardSnapshot() without that function needing to
 * know about three different decision shapes.
 *
 * A rejected decision explicitly uses the sentinel `'none'` for
 * `selectedProvider` — buildRouteLedgerEntry() defaults a nullish
 * `selectedProvider` to `'openai'` for caller convenience, which would
 * otherwise make a REJECTED task look, on the dashboard, like it was
 * silently routed to OpenAI. `'none'` sidesteps that default on purpose.
 */
export function toDashboardEntry(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new Error('toDashboardEntry: decision is required');
  }

  const r = decision.reasoning ?? {};

  if (decision.approved) {
    const confidence = Number.isFinite(r.triggeringTrustScore)
      ? r.triggeringTrustScore
      : Number.isFinite(r.qualityEstimate)
        ? r.qualityEstimate
        : 0.8;

    return buildRouteLedgerEntry({
      taskId: decision.taskId,
      selectedProvider: decision.primaryProvider,
      qualityTarget: decision.qualityTarget,
      confidence,
      batchPlan: decision.batchPlan,
      fallbackProvider: Array.isArray(decision.fallbackProviders) ? decision.fallbackProviders[0] ?? null : null,
      reason: r.selectedReason ?? 'approved',
      riskLevel: Array.isArray(r.warnings) && r.warnings.length > 0 ? 'medium' : 'low',
      createdAt: decision.decidedAt
    });
  }

  return buildRouteLedgerEntry({
    taskId: decision.taskId,
    selectedProvider: 'none',
    qualityTarget: decision.qualityTarget,
    confidence: 0,
    batchPlan: [],
    fallbackProvider: null,
    reason: decision.reason,
    riskLevel: 'high',
    createdAt: decision.decidedAt
  });
}
