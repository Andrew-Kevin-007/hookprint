/**
 * BATON dispatch — ledger/reputation.js
 *
 * Layer 5 (PRODUCT-ARCHITECTURE.md): reputation scoring tying agent
 * prediction accuracy back to dispatch trust, cryptographically bound via
 * @baton/sign so a reputation record is independently verifiable, not just
 * a number this process asserts about itself.
 *
 * ---- Formula choice: computeTrustScore (read this before changing it) ----
 * PRODUCT-ARCHITECTURE.md Layer 5 documents TWO trust-score formulas:
 *   1. trust_score = (accuracy_percentage / 100) ^ predictions_made
 *   2. "Better": trust_score = mean(last 20) * 0.7 + overall_accuracy * 0.3
 * The doc itself shows (1) decaying an agent with 90% accuracy to 0.00515
 * after just 50 predictions — i.e. it punishes an agent for having a long,
 * *accurate* track record, which is the opposite of what a reputation
 * system should reward. The doc presents this as the naive option
 * specifically so (2) — recency-weighted, no exponent — is the one chosen.
 * This module implements ONLY (2). See the "recency-weighted, not
 * exponential" test in tests/ledger.test.js for the concrete regression
 * this guards: 90% accuracy over 60 predictions must score HIGH, not ~0.
 *
 * ---- Formula choice: computeAccuracy (read this before changing it) ----
 * PRODUCT-ARCHITECTURE.md is internally inconsistent about which side of
 * the fraction is the denominator:
 *   - Layer 4 prose (line "Calculate error: abs(predicted - actual) / actual")
 *     says the denominator is `actual`.
 *   - The Layer 2 worked example, the Layer 4 worked verification record,
 *     AND the canonical Outcome schema's own comment
 *     ("tokens_error_pct: (actual - predicted) / predicted") all use
 *     `predicted` as the denominator — and ALL of them agree on the same
 *     concrete numbers: predicted 3600, actual 3450 -> error -4.2%,
 *     accuracy_score 0.958.
 *   Only `predicted` as the denominator reproduces 0.958
 *   (1 - abs((3450-3600)/3600) = 0.9583). `actual` as the denominator
 *   gives 0.9565, which does not match the doc's own worked example. The
 *   concrete, checkable number wins over the one inconsistent prose line —
 *   this is implemented against `predicted` as the denominator.
 *
 * ---- Decay policy ----
 * Threshold: 7 days since an agent's most recent prediction. Reasoning: a
 * daily-ish operational cadence (PRODUCT-ARCHITECTURE.md's own failure-mode
 * section treats *8 hours* of total system silence as enough to make POOL
 * burn-rate estimates unreliable) means a single agent going quiet for a
 * full week is a meaningfully different situation from normal day-to-day
 * gaps (weekends, a provider outage, a slow week) — long enough to be a
 * deliberate signal, short enough not to punish routine intermittent use.
 * It is exposed as `opts.decayThresholdDays` so an operator can tune it.
 *
 * Approach chosen (the doc offers two): **cap the credibility tier one
 * level below what raw accuracy would otherwise assign**, rather than
 * widening a reported uncertainty interval. Reasoning: this codebase's
 * dispatcher-facing consumers (provider-profiles.js, route-contracts.js)
 * make routing decisions off discrete tiers/quality bands, not off a
 * confidence interval — a capped tier is a value they can act on directly,
 * where a widened interval would need new consumer logic to have any
 * effect. `computeTrustScore()` itself stays decay-free and matches the
 * doc's formula exactly; decay is applied only in `buildReputationSnapshot()`
 * (analogous to PRODUCT-ARCHITECTURE.md's `ReputationSnapshot` schema),
 * which is the function that also assigns and reports the tier.
 *
 * ---- Fallback / fail-closed contract ----
 * `computeTrustScore([])`/`computeTrustScore(null)` and
 * `getAgentTrustScore()` against a missing/corrupted/agent-less ledger
 * never return a bare number. They return an explicit marker object
 * (`{ trustScore: null, confidence: 'none', reason }`) — exactly like
 * `packages/sign`'s `verifyBundle` never throwing and always returning a
 * clear `false` rather than an ambiguous value. A caller can distinguish
 * "real score" from "no data" with `typeof result === 'number'`.
 *
 * ---- Cryptographic binding ----
 * `recordPrediction()`/`recordOutcome()` sign their bundle via
 * @baton/sign's `signBundle()` before it is appended to the ledger, using
 * one ed25519 keypair per `agentId`. **MVP scope, named explicitly**: keys
 * are generated on first use and cached ONLY in this process's memory
 * (`AGENT_IDENTITIES` below) — there is no persistence across restarts and
 * no key rotation/revocation. A previously-signed ledger entry stays
 * independently verifiable forever (its public key travels inside the
 * envelope), but this process cannot prove a *new* signature comes from the
 * same identity as an *old* one after a restart wipes the cache — that
 * binding is @baton/registry's job (agent_id -> public key), not built
 * here.
 */

import { randomUUID } from 'node:crypto';
import { generateIdentity, signBundle } from '../../sign/index.js';
import { createLedgerEvent } from '../execution-contracts.js';
import { appendEvent, readEvents } from './store.js';

/** See "Decay policy" above for the reasoning behind 7 days. */
export const DEFAULT_DECAY_THRESHOLD_DAYS = 7;

const RECENT_WINDOW_SIZE = 20;
const RECENT_WEIGHT = 0.7;
const HISTORICAL_WEIGHT = 0.3;

const TIER_ORDER = ['red', 'yellow', 'blue', 'green', 'gold', 'diamond'];

// MVP in-memory identity cache — see file header "Cryptographic binding".
const AGENT_IDENTITIES = new Map();

/** Fetch (or lazily generate) the ed25519 identity used to sign this agent's records. */
export function getAgentIdentity(agentId) {
  if (!agentId || typeof agentId !== 'string') {
    throw new Error('getAgentIdentity: agentId must be a non-empty string');
  }
  if (!AGENT_IDENTITIES.has(agentId)) {
    AGENT_IDENTITIES.set(agentId, generateIdentity());
  }
  return AGENT_IDENTITIES.get(agentId);
}

/** Test/debug only: clear the in-memory identity cache. Never call this in a real dispatch loop. */
export function resetAgentIdentities() {
  AGENT_IDENTITIES.clear();
}

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Record a prediction, BEFORE its outcome is known: sign it with the
 * agent's identity and append the signed bundle to the ledger.
 *
 * @param {{ ledgerPath: string, agentId: string, taskId: string,
 *   predictedTokens: number, confidence?: number, reasoning?: string,
 *   provider?: string, predictionId?: string, timestamp?: string }} input
 * @returns {{ predictionId: string, event: object, signedBundle: object }}
 */
export function recordPrediction(input = {}) {
  const {
    ledgerPath,
    agentId,
    taskId,
    predictedTokens,
    confidence = null,
    reasoning = null,
    provider = null,
    predictionId = `pred-${randomUUID()}`,
    timestamp = new Date().toISOString()
  } = input;

  if (!ledgerPath) throw new Error('recordPrediction: ledgerPath is required');
  if (!agentId) throw new Error('recordPrediction: agentId is required');
  if (!taskId) throw new Error('recordPrediction: taskId is required');
  if (!Number.isFinite(predictedTokens)) throw new Error('recordPrediction: predictedTokens must be a finite number');

  const bundle = {
    type: 'prediction',
    predictionId,
    agentId,
    taskId,
    predictedTokens,
    confidence,
    reasoning,
    timestamp
  };

  const identity = getAgentIdentity(agentId);
  const attestation = signBundle(bundle, identity.privateKey, identity.publicKey);
  const signedBundle = { bundle, ...attestation };

  const event = createLedgerEvent({
    eventType: 'prediction-recorded',
    taskId,
    provider,
    routeId: null,
    payload: { signedBundle },
    timestamp
  });

  appendEvent(ledgerPath, event);

  return { predictionId, event, signedBundle };
}

/**
 * Record an outcome, tying it back to a prior prediction by `predictionId`.
 * The ledger itself — not a caller-supplied duplicate — is the source of
 * truth for what was predicted: this reads back the matching
 * `prediction-recorded` event to get `predictedTokens` before computing
 * accuracy, so a caller can never (accidentally or otherwise) score an
 * outcome against a different prediction than the one actually signed and
 * committed earlier.
 *
 * Uses `eventType: 'reputation-updated'` — execution-contracts.js's
 * `LEDGER_EVENT_TYPES` is frozen/reused, not modified, and this is the
 * closest fit among its 9 values: recording a verified prediction outcome
 * is precisely what triggers a reputation change, and no more specific
 * value (e.g. an `agent-prediction-verified` type) exists in that enum.
 *
 * @param {{ ledgerPath: string, agentId: string, taskId: string,
 *   predictionId: string, actualTokens: number, status?: string,
 *   latencyMs?: number, provider?: string, outcomeId?: string,
 *   timestamp?: string }} input
 * @returns {{ outcomeId: string, event: object, signedBundle: object, accuracy: number }}
 */
export function recordOutcome(input = {}) {
  const {
    ledgerPath,
    agentId,
    taskId,
    predictionId,
    actualTokens,
    status = 'success',
    latencyMs = null,
    provider = null,
    outcomeId = `outcome-${randomUUID()}`,
    timestamp = new Date().toISOString()
  } = input;

  if (!ledgerPath) throw new Error('recordOutcome: ledgerPath is required');
  if (!agentId) throw new Error('recordOutcome: agentId is required');
  if (!taskId) throw new Error('recordOutcome: taskId is required');
  if (!predictionId) throw new Error('recordOutcome: predictionId is required to tie an outcome back to its prediction');
  if (!Number.isFinite(actualTokens)) throw new Error('recordOutcome: actualTokens must be a finite number');

  const { events, readError } = readEvents(ledgerPath, { eventType: 'prediction-recorded', taskId });
  if (readError) {
    throw new Error(`recordOutcome: ledger at "${ledgerPath}" could not be read (${readError.code ?? readError.message})`);
  }
  const match = events.find((e) => e?.payload?.signedBundle?.bundle?.predictionId === predictionId);
  if (!match) {
    throw new Error(`recordOutcome: no prediction found in ledger for predictionId "${predictionId}" (taskId "${taskId}")`);
  }

  const predictedTokens = match.payload.signedBundle.bundle.predictedTokens;
  const accuracy = computeAccuracy(predictedTokens, actualTokens);

  const bundle = {
    type: 'outcome',
    outcomeId,
    predictionId,
    agentId,
    taskId,
    predictedTokens,
    actualTokens,
    accuracy,
    status,
    latencyMs,
    timestamp
  };

  const identity = getAgentIdentity(agentId);
  const attestation = signBundle(bundle, identity.privateKey, identity.publicKey);
  const signedBundle = { bundle, ...attestation };

  const event = createLedgerEvent({
    eventType: 'reputation-updated',
    taskId,
    provider,
    routeId: null,
    payload: { signedBundle },
    timestamp
  });

  appendEvent(ledgerPath, event);

  return { outcomeId, event, signedBundle, accuracy };
}

/**
 * 1.0 - abs((actual - predicted) / predicted) — see file header for why
 * `predicted` is the denominator. Guards the predicted===0 edge case
 * (undefined in the doc) to avoid returning NaN/Infinity: a zero-token
 * prediction that actually used zero tokens is a perfect prediction (1.0);
 * a zero-token prediction that used any real tokens is a maximally wrong
 * one (0), never a silent NaN.
 */
export function computeAccuracy(predicted, actual) {
  if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return 0;
  if (predicted === 0) return actual === 0 ? 1 : 0;
  return 1.0 - Math.abs((actual - predicted) / predicted);
}

/**
 * Recency-weighted trust score — see file header for why this formula and
 * not the doc's exponential-decay alternative.
 *
 * @param {Array<{ accuracy: number, timestamp?: string }>} agentHistory
 * @returns {number | { trustScore: null, confidence: 'none', reason: string }}
 *   A plain number in the normal case. An explicit low-confidence marker —
 *   NEVER a bare number — when there is no usable history. Callers can
 *   distinguish the two with `typeof result === 'number'`.
 */
export function computeTrustScore(agentHistory) {
  if (!Array.isArray(agentHistory) || agentHistory.length === 0) {
    return { trustScore: null, confidence: 'none', reason: 'no-history' };
  }

  const valid = agentHistory.filter((r) => r && Number.isFinite(r.accuracy));
  if (valid.length === 0) {
    return { trustScore: null, confidence: 'none', reason: 'no-valid-accuracy-records' };
  }

  const sorted = [...valid].sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  const recentSlice = sorted.slice(-RECENT_WINDOW_SIZE);

  const recentAccuracy = mean(recentSlice.map((r) => r.accuracy)) * RECENT_WEIGHT;
  const historicalAccuracy = mean(sorted.map((r) => r.accuracy)) * HISTORICAL_WEIGHT;

  return recentAccuracy + historicalAccuracy;
}

/**
 * Credibility tier from accuracy + volume, thresholds exactly as documented
 * in PRODUCT-ARCHITECTURE.md Layer 5.
 *
 * @param {number} accuracyPercentage - 0-100 scale (e.g. 91.0 for 91%
 *   accuracy) — NOT the 0-1 fraction computeAccuracy()/computeTrustScore()
 *   return. Multiply by 100 before calling this.
 * @param {number} predictionsMade
 * @returns {'red'|'yellow'|'blue'|'green'|'gold'|'diamond'}
 */
export function assignCredibilityTier(accuracyPercentage, predictionsMade) {
  const pct = Number.isFinite(accuracyPercentage) ? accuracyPercentage : -Infinity; // invalid input fails closed to 'red'
  const made = Number.isFinite(predictionsMade) ? predictionsMade : 0;

  if (pct > 97 && made > 100) return 'diamond'; // both conditions required — not accuracy alone
  if (pct > 92) return 'gold';
  if (pct >= 85) return 'green'; // 85-92
  if (pct >= 75) return 'blue'; // 75-85
  if (pct >= 60) return 'yellow'; // 60-75
  return 'red'; // <60
}

function capTierOneLevelDown(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  if (idx <= 0) return tier; // already at the floor ('red'), or an unrecognized tier — nothing to cap
  return TIER_ORDER[idx - 1];
}

/** Simple three-bucket trend: compare the most recent half of the history to the older half. */
function computeConfidenceTrend(sortedByTime) {
  if (sortedByTime.length < 4) return 'stable'; // too little data to call a trend either way
  const mid = Math.floor(sortedByTime.length / 2);
  const olderMean = mean(sortedByTime.slice(0, mid).map((r) => r.accuracy));
  const recentMean = mean(sortedByTime.slice(mid).map((r) => r.accuracy));
  const delta = recentMean - olderMean;
  if (delta > 0.03) return 'improving';
  if (delta < -0.03) return 'declining';
  return 'stable';
}

/**
 * Build a PRODUCT-ARCHITECTURE.md-shaped `ReputationSnapshot`: trust score,
 * credibility tier, and the decay policy (see file header), from an
 * already-fetched history array (as `computeTrustScore` takes).
 *
 * @param {string} agentId
 * @param {Array<{ accuracy: number, timestamp?: string }>} agentHistory
 * @param {{ now?: Date, decayThresholdDays?: number }} [opts]
 */
export function buildReputationSnapshot(agentId, agentHistory, opts = {}) {
  const { now = new Date(), decayThresholdDays = DEFAULT_DECAY_THRESHOLD_DAYS } = opts;

  const trust = computeTrustScore(agentHistory);

  if (typeof trust !== 'number') {
    return {
      agentId,
      timestamp: now.toISOString(),
      totalPredictions: 0,
      accuracyPercentage: null,
      trustScore: null,
      confidence: 'none',
      confidenceTrend: 'unknown',
      credibilityTier: 'red', // fail closed: no track record is never silently upgraded
      stale: null,
      decayApplied: false,
      reason: trust.reason
    };
  }

  const valid = agentHistory.filter((r) => r && Number.isFinite(r.accuracy));
  const sorted = [...valid].sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
  const overallAccuracyPct = mean(sorted.map((r) => r.accuracy)) * 100;

  const lastTimestamp = sorted[sorted.length - 1].timestamp;
  const lastMs = Date.parse(lastTimestamp);
  const ageDays = Number.isFinite(lastMs) ? (now.getTime() - lastMs) / (24 * 60 * 60 * 1000) : Infinity;
  const stale = ageDays > decayThresholdDays;

  let tier = assignCredibilityTier(overallAccuracyPct, sorted.length);
  if (stale) tier = capTierOneLevelDown(tier);

  return {
    agentId,
    timestamp: now.toISOString(),
    totalPredictions: sorted.length,
    accuracyPercentage: Number(overallAccuracyPct.toFixed(2)),
    trustScore: Number(trust.toFixed(4)),
    confidence: stale ? 'reduced' : 'normal',
    confidenceTrend: computeConfidenceTrend(sorted),
    credibilityTier: tier,
    stale,
    decayApplied: stale,
    lastPredictionAt: Number.isFinite(lastMs) ? lastTimestamp : null,
    ageDaysSinceLastPrediction: Number.isFinite(ageDays) ? Number(ageDays.toFixed(2)) : null
  };
}

/** Extract `{ accuracy, timestamp, taskId, predictionId }` history entries for one agent from raw ledger events. */
function buildAgentHistoryFromEvents(events, agentId) {
  return events
    .filter((e) => e?.eventType === 'reputation-updated' && e?.payload?.signedBundle?.bundle?.agentId === agentId)
    .map((e) => {
      const b = e.payload.signedBundle.bundle;
      return { accuracy: b.accuracy, timestamp: b.timestamp, taskId: b.taskId, predictionId: b.predictionId };
    });
}

/**
 * The ledger-reading entry point for the fallback contract described in
 * the file header: reads `ledgerPath`, extracts this agent's verified
 * outcome history, and returns a `buildReputationSnapshot()` result — or an
 * explicit low-confidence marker (never a bare number) when the ledger is
 * missing, unreadable, or has no history for this agent yet.
 *
 * @param {string} ledgerPath
 * @param {string} agentId
 * @param {{ now?: Date, decayThresholdDays?: number }} [opts]
 */
export function getAgentTrustScore(ledgerPath, agentId, opts = {}) {
  const { events, readError } = readEvents(ledgerPath);

  if (readError) {
    return { trustScore: null, confidence: 'none', reason: 'ledger-unreadable', detail: readError };
  }

  const history = buildAgentHistoryFromEvents(events, agentId);
  if (history.length === 0) {
    return { trustScore: null, confidence: 'none', reason: 'no-history-for-agent' };
  }

  return buildReputationSnapshot(agentId, history, opts);
}
