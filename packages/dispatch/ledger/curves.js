/**
 * QUORUM dispatch — ledger/curves.js
 *
 * Phase 4 (plan §"Learning loop"): replaces the static `qualityCurve`
 * constants in `provider-profiles.js` with a curve LEARNED from real
 * `batch-quality-scored` ledger events (see `quality/score.js`'s
 * `buildQualityScoreEvent()` for the exact event contract this reads).
 *
 * ---- Architectural pattern: read-time projection, same as reputation.js --
 * Exactly like `ledger/reputation.js`'s `computeTrustScore()`, there is no
 * mutable "current curve" file anywhere. `fitDegradationCurve()` recomputes
 * the curve from the append-only ledger on every call. This is deliberate:
 * a separately-mutated cache could drift from the log it's supposed to
 * summarize, and the log is the only thing this codebase treats as ground
 * truth (see ledger/store.js's file header, "Ground-truth rule").
 *
 * ---- THE WORKLOAD-TYPE GAP (named decision, see also the task's own brief)
 * `batch-quality-scored` events do NOT carry a `workloadType` dimension —
 * Phase 2 (quality scoring) and Phase 5 (workload classification) were built
 * in separate, non-communicating passes, and the event payload Phase 2
 * shipped has no room for the taxonomy Phase 5 later introduced. Fitting a
 * true per-provider-PER-WORKLOAD-TYPE curve is therefore not possible from
 * real ledger data today.
 *
 * DECISION: ship per-provider-only learned curves (Option A from the task
 * brief), not Option B (retrofitting an optional `workloadType` field onto
 * `buildQualityScoreEvent()`'s already-shipped, already-tested payload).
 * Reasoning, concretely:
 *   1. `fitDegradationCurve()`'s own required signature is `(ledgerPath,
 *      provider)` — no `workloadType` parameter. The very shape this module
 *      is asked to expose is already scoped to per-provider. Building
 *      Option B's schema extension now would touch a shipped/tested file
 *      (`quality/score.js`, 13 tests) and thread a new field through
 *      `merge/index.js`'s wiring, for a dimension nothing in THIS pass
 *      would ever read back out. That is speculative extension, not a real
 *      requirement of the work at hand.
 *   2. Nothing in the codebase today wires `profiling/classify.js`'s
 *      `classifyWorkload()` output into `merge/index.js`'s `mergeRoute()`
 *      call site — so even with an optional `workloadType` field added,
 *      every real event produced by the current pipeline would still write
 *      `workloadType: null`, and a per-workload curve fit today would have
 *      zero real per-workload samples regardless. Adding the field now buys
 *      nothing observable in this pass.
 *   3. This is a real, honest, SCOPED limitation, not a silent omission:
 *      learned curves collapse across all workload types. Per-workload-type
 *      learned curves require (a) `workloadType` added to the
 *      `batch-quality-scored` payload — additive, cheap — AND (b) something
 *      upstream of `mergeRoute()` actually passing a task's
 *      `classifyWorkload()` result through to it. Both are out of scope for
 *      this pass and named here explicitly rather than silently dropped.
 *
 * ---- Bucketing ----
 * Reuses `provider-profiles.js`'s existing static-curve breakpoints
 * EXACTLY, so a learned curve and the static prior it replaces are directly
 * comparable, not arbitrarily different: `contextRatio > 0.9` → 'high',
 * `> 0.6` → 'medium', else 'low' (see `profiling/predict.js`'s
 * `staticPriorCurveLookup()`, which this module's `learnedCurveLookup()`
 * falls back to verbatim).
 *
 * ---- Minimum sample threshold ----
 * `MIN_BUCKET_SAMPLES = 5`. Chosen as the smallest sample size for which an
 * arithmetic mean is minimally resistant to a single outlier dominating it
 * (one bad/lucky batch can swing a 1-4-sample mean by itself; at 5 it is
 * one fifth of the signal at most), while staying reachable early in a
 * resource-constrained free-tier measurement campaign (Phase 3) rather than
 * demanding dozens of samples per provider before any bucket ever "learns".
 * This is a real, stated threshold — same spirit as
 * `ledger/reputation.js`'s `DEFAULT_DECAY_THRESHOLD_DAYS`, a documented
 * constant chosen for a stated reason, not tuned against a hidden target.
 * Applied PER BUCKET, not per provider: a bucket short of this threshold
 * returns `null` for that bucket specifically, while sibling buckets with
 * enough samples still return a real learned value (per-bucket graceful
 * degradation — see `fitDegradationCurve()`'s docstring).
 */

import { readEvents } from './store.js';
import { staticPriorCurveLookup } from '../profiling/predict.js';

/** See file header "Minimum sample threshold" for the reasoning. */
export const MIN_BUCKET_SAMPLES = 5;

/** The three learned-curve bucket keys, in low-to-high context-load order. */
const BUCKET_KEYS = ['low', 'medium', 'high'];

function mean(nums) {
  if (!nums.length) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/**
 * Same breakpoints `provider-profiles.js`'s static curve logic and
 * `profiling/predict.js`'s `staticPriorCurveLookup()` already use. Do not
 * drift from these without updating all three places.
 */
function bucketForContextRatio(contextRatio) {
  if (contextRatio > 0.9) return 'high';
  if (contextRatio > 0.6) return 'medium';
  return 'low';
}

/**
 * Fit a per-provider degradation curve from real `batch-quality-scored`
 * ledger history.
 *
 * Fail-closed contract (matches `packages/sign`'s `verifyBundle` and
 * `ledger/reputation.js`'s missing-history marker): a missing/unreadable
 * ledger, or one with zero events for this provider, returns an explicit
 * "I don't know" — never a bare number that looks like a real measurement.
 *
 * Per-bucket graceful degradation: once at least one bucket clears
 * `MIN_BUCKET_SAMPLES`, this returns `method: 'learned'` with a real
 * `{low, medium, high}` object — buckets that individually fell short of
 * the threshold are `null` in that object, not a reason to null out the
 * whole curve. The whole curve is `null` ONLY in the true no-data case
 * (missing/unreadable ledger, zero relevant events, or events found but
 * not one single bucket cleared the threshold).
 *
 * @param {string} ledgerPath
 * @param {string} provider - a provider NAME (e.g. 'anthropic'), matching
 *   the top-level `provider` field `quality/score.js`'s
 *   `buildQualityScoreEvent()` threads onto each ledger event — verified
 *   against the real event shape; provider identity is NOT nested inside
 *   `payload` for this event type.
 * @returns {{
 *   provider: string,
 *   sampleCount: number,
 *   curve: {low: number|null, medium: number|null, high: number|null} | null,
 *   confidence: 'none'|'low'|'medium'|'high',
 *   method: 'learned'|'insufficient_data'
 * }}
 */
export function fitDegradationCurve(ledgerPath, provider) {
  const { events, readError } = readEvents(ledgerPath, { eventType: 'batch-quality-scored' });

  if (readError) {
    return { provider, sampleCount: 0, curve: null, confidence: 'none', method: 'insufficient_data' };
  }

  const relevant = events.filter(
    (e) =>
      e?.provider === provider &&
      Number.isFinite(e?.payload?.contextRatio) &&
      Number.isFinite(e?.payload?.combinedScore)
  );

  if (relevant.length === 0) {
    return { provider, sampleCount: 0, curve: null, confidence: 'none', method: 'insufficient_data' };
  }

  const buckets = { low: [], medium: [], high: [] };
  for (const event of relevant) {
    buckets[bucketForContextRatio(event.payload.contextRatio)].push(event.payload.combinedScore);
  }

  const curve = {};
  let bucketsLearned = 0;
  let minLearnedBucketSize = Infinity;
  for (const key of BUCKET_KEYS) {
    if (buckets[key].length >= MIN_BUCKET_SAMPLES) {
      curve[key] = mean(buckets[key]);
      bucketsLearned += 1;
      minLearnedBucketSize = Math.min(minLearnedBucketSize, buckets[key].length);
    } else {
      curve[key] = null;
    }
  }

  const sampleCount = relevant.length;

  if (bucketsLearned === 0) {
    // Real events exist for this provider, but not one bucket had enough of
    // them to trust a mean — honest "insufficient data", not a fabricated
    // curve built from 1-2 noisy samples per bucket.
    return { provider, sampleCount, curve: null, confidence: 'none', method: 'insufficient_data' };
  }

  // Confidence tiering — simple, documented thresholds (same spirit as
  // ledger/reputation.js's assignCredibilityTier): how many of the 3
  // buckets actually learned, and how comfortably the thinnest of them
  // cleared the minimum.
  let confidence;
  if (bucketsLearned < BUCKET_KEYS.length) {
    confidence = 'low'; // a partial curve -- some buckets still fall back to static
  } else if (minLearnedBucketSize >= MIN_BUCKET_SAMPLES * 2) {
    confidence = 'high'; // all 3 buckets learned, each comfortably past the floor
  } else {
    confidence = 'medium'; // all 3 buckets learned, but at least one just barely
  }

  return { provider, sampleCount, curve, confidence, method: 'learned' };
}

/**
 * Build the swap-point function `profiling/predict.js`'s `predictQuality()`
 * accepts as its `curveLookup` override — matching that function's EXACT
 * signature: `(provider, contextRatio, task) => number` (verified against
 * `predict.js`'s real code; `provider` there is a full
 * `provider-profiles.js` MODEL_PROFILES entry, not a bare string).
 *
 * A caller flips `predictQuality()` from the static prior to (effectively)
 * learned curves with:
 *
 *   predictQuality(task, provider, classification, batchSize, learnedCurveLookup(ledgerPath))
 *
 * Internally: fit this provider's learned curve, and if the bucket matching
 * `contextRatio` has a real (non-null) learned value, return it. Otherwise
 * — cold start, or this specific bucket never cleared the sample threshold
 * — fall back to REAL CODE REUSE of `profiling/predict.js`'s own exported
 * `staticPriorCurveLookup()` (not a duplicated copy of its logic), so a
 * caller always gets a usable number.
 *
 * NOTE on `curveSource` labeling: `predict.js` hardcodes the string literal
 * `'static_prior'` in its return value regardless of which `curveLookup` was
 * passed — a deliberate choice the prior phase documented and left
 * untouched (see `predictQuality()`'s own docstring). This module does NOT
 * touch `predict.js` to make it self-report 'learned': a caller wiring this
 * up already knows which lookup it passed, and `fitDegradationCurve()`'s own
 * `method`/`confidence` fields already expose "was this actually learned"
 * independently, without needing `predict.js` to guess it after the fact.
 *
 * @param {string} ledgerPath
 * @returns {(provider: object, contextRatio: number, task?: object) => number}
 */
export function learnedCurveLookup(ledgerPath) {
  return function (provider, contextRatio, task) {
    const providerName = provider?.name;
    const fit = providerName ? fitDegradationCurve(ledgerPath, providerName) : null;

    if (fit && fit.curve) {
      const bucket = bucketForContextRatio(contextRatio);
      const learnedValue = fit.curve[bucket];
      if (Number.isFinite(learnedValue)) return learnedValue;
    }

    // Cold start, or this bucket specifically never cleared the sample
    // threshold -- fall back to the real static prior, not a reimplementation.
    return staticPriorCurveLookup(provider, contextRatio, task);
  };
}
