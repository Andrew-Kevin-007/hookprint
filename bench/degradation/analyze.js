/**
 * bench/degradation/analyze.js — turning raw campaign cells into curves.
 *
 * Read-time projection only, no separate mutable state: exactly the pattern
 * `ledger/reputation.js`'s `computeTrustScore()` already uses to project
 * trust scores by replaying the ledger, rather than maintaining a
 * competing score file that could drift from it. `loadCampaignResults()`
 * replays every `'campaign-cell-completed'` event; nothing here is ever
 * written back to the ledger.
 */

import { readEvents } from '../../packages/dispatch/ledger/store.js';

/**
 * Read every `'campaign-cell-completed'` event back out of the ledger and
 * flatten it to the shape `computeDegradationCurve()` consumes.
 *
 * @param {string} ledgerPath
 * @returns {Array<{
 *   provider: string, batchSize: number, repetition: number,
 *   contextRatio: number|null, qualityScore: number|null,
 *   latencyMs: number, actualTokens: number, status: string,
 *   mergeStatus: string, errorClass: string|null,
 *   taskId: string, timestamp: string
 * }>}
 */
export function loadCampaignResults(ledgerPath) {
  const { events } = readEvents(ledgerPath, { eventType: 'campaign-cell-completed' });
  return events.map((event) => ({
    provider: event.provider,
    batchSize: event.payload?.batchSize ?? null,
    repetition: event.payload?.repetition ?? null,
    contextRatio: event.payload?.contextRatio ?? null,
    qualityScore: event.payload?.qualityScore ?? null,
    latencyMs: event.payload?.latencyMs ?? null,
    actualTokens: event.payload?.actualTokens ?? null,
    status: event.payload?.status ?? null,
    mergeStatus: event.payload?.mergeStatus ?? null,
    errorClass: event.payload?.errorClass ?? null,
    taskId: event.taskId,
    timestamp: event.timestamp
  }));
}

/** A bucket's mean is only trusted once at least this many successful
 * samples land in it. With `REPETITIONS_PER_CELL = 3` (campaign.js), a
 * fully-successful bucket has 3; requiring >= 2 tolerates exactly one
 * failed repetition (quota/timeout/error) in that bucket without discarding
 * it outright, while still refusing to trend off a single data point. */
const MIN_SAMPLES_PER_BUCKET = 2;

/**
 * A drop in mean `combinedScore` (quality/score.js's [0,1] metric) larger
 * than this, between the smallest- and largest-context-load USABLE buckets,
 * is judged a real degradation signal rather than run-to-run noise.
 * Deliberately a simple absolute threshold on a [0,1] score, not a
 * regression or a statistical test — per the task brief's own instruction
 * not to overfit this analysis. 0.05 (5 percentage points) is chosen
 * because it comfortably exceeds this metric's normal single-batch noise
 * floor (a genuinely stable provider's `deterministicScore` varies by a
 * few hundredths across identical repeated calls in this codebase's own
 * quality-score tests) while still catching a real, visible decline.
 */
const DEGRADATION_DROP_THRESHOLD = 0.05;

/**
 * Compute one provider's degradation curve: quality as a function of
 * context load, bucketed by `contextRatio`.
 *
 * X-AXIS CHOICE: `contextRatio`, not `batchSize`. Reasoning:
 * `quality/score.js`'s `buildQualityScoreEvent()` docstring names
 * `contextRatio` explicitly as "the x-axis for degradation curves later" —
 * it is the actual fraction of a provider's context window consumed, which
 * is what varies the model's real workload; `batchSize` is only a proxy for
 * that, and a different proxy per provider (provider-profiles.js's
 * `tokensPerItem`/`contextWindow` differ per provider, so the SAME
 * batchSize maps to a DIFFERENT contextRatio on each one — e.g. batchSize 8
 * loads gemini's 1,048,576-token window far more lightly than cerebras's
 * 65,536-token one). Bucketing by contextRatio is what makes curves from
 * different providers comparable on the same axis at all. In this
 * campaign's actual data every (provider, batchSize) cell already maps to
 * exactly one contextRatio value deterministically (same corpus slice,
 * same provider profile every repetition), so bucketing by contextRatio
 * versus batchSize produces the identical grouping here — the choice
 * matters for how the resulting curve generalizes across providers, not
 * for anything this specific campaign's numbers would show differently.
 *
 * @param {Array<{provider:string, contextRatio:number|null, qualityScore:number|null}>} results
 * @param {string} provider
 * @returns {{
 *   provider: string,
 *   points: Array<{ contextRatio: number, meanQuality: number, stddev: number, n: number }>,
 *   trend: 'degrades'|'flat'|'insufficient_data'
 * }}
 */
export function computeDegradationCurve(results, provider) {
  const safeResults = Array.isArray(results) ? results : [];
  const providerResults = safeResults.filter(
    (r) => r?.provider === provider && Number.isFinite(r?.contextRatio) && Number.isFinite(r?.qualityScore)
  );

  const buckets = new Map();
  for (const r of providerResults) {
    const key = r.contextRatio.toFixed(6);
    if (!buckets.has(key)) buckets.set(key, { contextRatio: r.contextRatio, scores: [] });
    buckets.get(key).scores.push(r.qualityScore);
  }

  const points = [...buckets.values()]
    .map(({ contextRatio, scores }) => {
      const n = scores.length;
      const meanQuality = scores.reduce((sum, v) => sum + v, 0) / n;
      const variance = n > 1 ? scores.reduce((sum, v) => sum + (v - meanQuality) ** 2, 0) / (n - 1) : 0;
      return { contextRatio, meanQuality, stddev: Math.sqrt(variance), n };
    })
    .sort((a, b) => a.contextRatio - b.contextRatio);

  const usableBuckets = points.filter((p) => p.n >= MIN_SAMPLES_PER_BUCKET);

  let trend;
  if (usableBuckets.length < 2) {
    trend = 'insufficient_data';
  } else {
    const smallest = usableBuckets[0];
    const largest = usableBuckets[usableBuckets.length - 1];
    const drop = smallest.meanQuality - largest.meanQuality;
    trend = drop > DEGRADATION_DROP_THRESHOLD ? 'degrades' : 'flat';
  }

  return { provider, points, trend };
}
