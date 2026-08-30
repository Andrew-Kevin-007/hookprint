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
 * ---- THE WORKLOAD-TYPE GAP -- CLOSED ----
 * This module previously shipped per-provider-ONLY learned curves (Option A
 * from the original phase-4 brief), documented here as deliberately deferred
 * because of a two-part prerequisite: (a) `batch-quality-scored` events
 * carried no `workloadType` dimension, and (b) nothing wired
 * `profiling/classify.js`'s `classifyWorkload()` output through to
 * `merge/index.js`'s `mergeRoute()` call site that builds those events. Both
 * prerequisites are now done (Option B):
 *   (a) `quality/score.js`'s `buildQualityScoreEvent()` accepts an OPTIONAL
 *       `workloadType` field and includes it in the recorded payload only
 *       when supplied — see that function's own docstring for the exact
 *       "omitted -> byte-identical to before" discipline.
 *   (b) `merge/index.js`'s `mergeRoute()` accepts an optional
 *       `options.workloadType` / `options.workloadClassification` and
 *       threads it into every `buildQualityScoreEvent()` call it makes.
 * `fitDegradationCurve()` below now takes an OPTIONAL third `workloadType`
 * parameter and, when given, fits a curve scoped to that workload type FIRST
 * per bucket, falling back to the pre-existing all-workload-types
 * (provider-wide) computation for any bucket that does not have enough
 * same-workload-type samples yet (see "Per-bucket graceful degradation,
 * workload-aware" below) — real, honest degradation, never a fabricated
 * workload-specific number and never a bare "no data" when a usable
 * provider-wide number exists. `learnedCurveLookup()` and `rankProviders()`
 * (`provider-profiles.js`) both now derive a task's workload type via the
 * shared `deriveWorkloadType()` helper below and pass it through
 * automatically — a caller does not need to compute or pass workloadType by
 * hand for either of those two entry points.
 *
 * WHAT IS STILL A REAL, HONEST LIMITATION AFTER THIS PASS:
 *   - Cold start is still cold start, just at a narrower grain: the FIRST
 *     time a given (provider, workloadType, bucket) combination is seen with
 *     zero same-workload-type samples AND zero provider-wide samples for
 *     that bucket, there is nothing to learn from and `curve[bucket]` is
 *     `null` — exactly as honest today as the old per-provider-only version
 *     was for a brand-new provider. This is expected and is not silently
 *     hidden: `bucketSources[bucket]` is `null` in that case too.
 *   - A provider that has plenty of provider-wide history but has never
 *     specifically been asked to do this exact `workloadType` will keep
 *     falling back to the provider-wide value for a while, which is the
 *     intended, honest behavior (a provider-wide mean IS real information,
 *     just coarser-grained than a workload-specific one) — not a bug, but
 *     worth knowing so nobody mistakes an early `source: 'provider_wide'`
 *     for a workload-specific measurement.
 *   - `classifyWorkload()` itself is a deterministic heuristic cascade (see
 *     `profiling/classify.js`'s own file header) — a task's workload label
 *     can be wrong or low-confidence, and this module has no way to tell a
 *     confident classification apart from a fallback one when it derives
 *     `workloadType` from a task (see `deriveWorkloadType()` below for what
 *     it currently ignores).
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
import { classifyWorkload } from '../profiling/classify.js';

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
 * Fit a degradation curve from real `batch-quality-scored` ledger history —
 * per-provider, or per-provider-per-workload-type when `workloadType` is
 * given.
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
 * Per-bucket graceful degradation, WORKLOAD-AWARE (only engaged when
 * `workloadType` is supplied): each bucket is filtered to
 * `payload.workloadType === workloadType` FIRST. If that workload-specific
 * subset clears `MIN_BUCKET_SAMPLES` for a given bucket, its mean is used
 * (`bucketSources[bucket] = 'workload_specific'`). Otherwise the bucket
 * falls back to the SAME across-all-workload-types computation this
 * function has always done for that bucket (`bucketSources[bucket] =
 * 'provider_wide'`) rather than returning null outright — a real,
 * honest measurement one grain coarser is strictly better than "no data" or
 * silently treating a different workload's samples as if they were this
 * one's. Only a bucket with NEITHER enough workload-specific NOR enough
 * provider-wide samples is `null` (`bucketSources[bucket] = null`). This is
 * per-bucket independence, same as the provider-only version: one bucket
 * falling back does not affect a sibling bucket that has real
 * workload-specific data.
 *
 * `workloadType` OMITTED (`undefined`, or explicitly `null`): EXACT
 * pre-existing behavior — the workload dimension is never consulted, no
 * `workloadType`/`bucketSources` keys appear anywhere in the return value,
 * and the numbers produced are byte-identical to this function's behavior
 * before workload-awareness existed (this collapses to the same
 * provider-wide computation described above, since the workload-specific
 * branch is simply never taken).
 *
 * @param {string} ledgerPath
 * @param {string} provider - a provider NAME (e.g. 'anthropic'), matching
 *   the top-level `provider` field `quality/score.js`'s
 *   `buildQualityScoreEvent()` threads onto each ledger event — verified
 *   against the real event shape; provider identity is NOT nested inside
 *   `payload` for this event type.
 * @param {string} [workloadType] - optional; one of
 *   `profiling/classify.js`'s `WORKLOAD_TYPES`, matching the (optional)
 *   `payload.workloadType` field `quality/score.js`'s
 *   `buildQualityScoreEvent()` may have recorded on an event.
 * @returns {{
 *   provider: string,
 *   sampleCount: number,
 *   curve: {low: number|null, medium: number|null, high: number|null} | null,
 *   confidence: 'none'|'low'|'medium'|'high',
 *   method: 'learned'|'insufficient_data',
 *   workloadType?: string,
 *   bucketSources?: {low: 'workload_specific'|'provider_wide'|null, medium: ..., high: ...}
 * }}
 *   `workloadType`/`bucketSources` are present ONLY when the `workloadType`
 *   parameter was actually supplied — see the omission discipline above.
 */
export function fitDegradationCurve(ledgerPath, provider, workloadType) {
  const filterByWorkload = workloadType != null;
  const withWorkloadTag = (obj) => (filterByWorkload ? { ...obj, workloadType } : obj);

  const { events, readError } = readEvents(ledgerPath, { eventType: 'batch-quality-scored' });

  if (readError) {
    return withWorkloadTag({ provider, sampleCount: 0, curve: null, confidence: 'none', method: 'insufficient_data' });
  }

  const relevant = events.filter(
    (e) =>
      e?.provider === provider &&
      Number.isFinite(e?.payload?.contextRatio) &&
      Number.isFinite(e?.payload?.combinedScore)
  );

  if (relevant.length === 0) {
    return withWorkloadTag({ provider, sampleCount: 0, curve: null, confidence: 'none', method: 'insufficient_data' });
  }

  // Provider-wide, across ALL workload types -- exactly today's pre-existing
  // per-provider-only computation, reused verbatim (not reimplemented) both
  // as the whole answer when no workloadType filter applies, and as the
  // per-bucket fallback pool when it does.
  const providerWideBuckets = { low: [], medium: [], high: [] };
  for (const event of relevant) {
    providerWideBuckets[bucketForContextRatio(event.payload.contextRatio)].push(event.payload.combinedScore);
  }

  // Workload-specific subset -- only ever computed when actually needed.
  let workloadBuckets = null;
  if (filterByWorkload) {
    workloadBuckets = { low: [], medium: [], high: [] };
    for (const event of relevant) {
      if (event?.payload?.workloadType === workloadType) {
        workloadBuckets[bucketForContextRatio(event.payload.contextRatio)].push(event.payload.combinedScore);
      }
    }
  }

  const curve = {};
  const bucketSources = filterByWorkload ? {} : null;
  let bucketsLearned = 0;
  let minLearnedBucketSize = Infinity;

  for (const key of BUCKET_KEYS) {
    if (filterByWorkload && workloadBuckets[key].length >= MIN_BUCKET_SAMPLES) {
      curve[key] = mean(workloadBuckets[key]);
      bucketSources[key] = 'workload_specific';
      bucketsLearned += 1;
      minLearnedBucketSize = Math.min(minLearnedBucketSize, workloadBuckets[key].length);
    } else if (providerWideBuckets[key].length >= MIN_BUCKET_SAMPLES) {
      // Either no workload filter at all, or the workload-specific subset
      // for this bucket fell short -- fall back to the provider-wide value
      // for THIS bucket specifically (per-bucket independence).
      curve[key] = mean(providerWideBuckets[key]);
      if (filterByWorkload) bucketSources[key] = 'provider_wide';
      bucketsLearned += 1;
      minLearnedBucketSize = Math.min(minLearnedBucketSize, providerWideBuckets[key].length);
    } else {
      curve[key] = null;
      if (filterByWorkload) bucketSources[key] = null;
    }
  }

  // sampleCount is always the provider-wide event count (how many real
  // events did this provider have at all), independent of the workload
  // filter -- matching this function's pre-existing meaning. The
  // workload-specific counts that actually decided each bucket are visible
  // per-bucket via bucketSources plus the curve values themselves.
  const sampleCount = relevant.length;

  if (bucketsLearned === 0) {
    // Real events exist for this provider, but not one bucket had enough of
    // them (workload-specific OR provider-wide) to trust a mean — honest
    // "insufficient data", not a fabricated curve built from 1-2 noisy
    // samples per bucket.
    return withWorkloadTag({
      provider,
      sampleCount,
      curve: null,
      confidence: 'none',
      method: 'insufficient_data',
      ...(filterByWorkload ? { bucketSources } : {})
    });
  }

  // Confidence tiering — simple, documented thresholds (same spirit as
  // ledger/reputation.js's assignCredibilityTier): how many of the 3
  // buckets actually learned, and how comfortably the thinnest of them
  // cleared the minimum. Unchanged by workload-awareness: a bucket learned
  // via provider-wide fallback still counts as "learned" here, same as
  // before this pass.
  let confidence;
  if (bucketsLearned < BUCKET_KEYS.length) {
    confidence = 'low'; // a partial curve -- some buckets still fall back to static
  } else if (minLearnedBucketSize >= MIN_BUCKET_SAMPLES * 2) {
    confidence = 'high'; // all 3 buckets learned, each comfortably past the floor
  } else {
    confidence = 'medium'; // all 3 buckets learned, but at least one just barely
  }

  return withWorkloadTag({
    provider,
    sampleCount,
    curve,
    confidence,
    method: 'learned',
    ...(filterByWorkload ? { bucketSources } : {})
  });
}

/**
 * Derive a task's workload type for `fitDegradationCurve()`'s optional third
 * parameter, via the real `profiling/classify.js` classifier — not a
 * reimplementation. Shared by `learnedCurveLookup()` below and
 * `provider-profiles.js`'s `rankProviders()`, so "how do we get a
 * workloadType out of a task" is decided in exactly one place.
 *
 * Returns `undefined` (never a string) when `task` itself is missing —
 * `undefined` is what makes `fitDegradationCurve()` take its
 * `workloadType`-omitted, byte-identical-to-before code path rather than
 * filtering on a fabricated value.
 *
 * Deliberately ignores `classifyWorkload()`'s own `confidence`/`method`
 * fields for now — even a low-confidence fallback classification ('summarization',
 * `method: 'fallback'`) is used as-is. This is a real, named limitation (see
 * this file's header): a wrong or low-confidence label can route a lookup to
 * the wrong workload bucket. Weighting or gating on confidence is future
 * work, not silently assumed to already happen here.
 *
 * @param {object} [task]
 * @returns {string|undefined}
 */
export function deriveWorkloadType(task) {
  if (task == null) return undefined;
  return classifyWorkload(task).workloadType;
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
 * Internally: derive `task`'s workload type via `deriveWorkloadType()` (real
 * `classifyWorkload()` reuse, not a duplicated cascade), fit this
 * provider's-and-workload's learned curve, and if the bucket matching
 * `contextRatio` has a real (non-null) learned value, return it — whether
 * that value came from workload-specific data or `fitDegradationCurve()`'s
 * own provider-wide per-bucket fallback (see that function's docstring; both
 * are real numbers, just at different grains). Otherwise — cold start, or
 * this specific bucket never cleared the sample threshold either way — fall
 * back to REAL CODE REUSE of `profiling/predict.js`'s own exported
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
    const workloadType = deriveWorkloadType(task);
    const fit = providerName ? fitDegradationCurve(ledgerPath, providerName, workloadType) : null;

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
