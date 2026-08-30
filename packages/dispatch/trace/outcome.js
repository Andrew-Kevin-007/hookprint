/**
 * QUORUM dispatch — trace/outcome.js
 *
 * Phase 6 (plan §"Explainability and the loop closed"): the predicted-vs-
 * actual comparison. `profiling/predict.js`'s `predictQuality()` produces a
 * PRE-execution `predictedQuality` number; `quality/score.js`'s `scoreBatch()`
 * produces a POST-execution `combinedScore`. Nothing in this codebase, before
 * this module, ever put those two numbers side by side — this is that
 * comparison, and it is the entire point of "explainability": a route
 * decision that predicted 0.75 and actually scored 0.30 is a concrete,
 * checkable claim about this product's own honesty, not a vague one.
 *
 * Pure, no I/O — matches this codebase's established "compute, don't mutate"
 * convention (`merge/consistency.js`'s `compareClaims()`, `quality/score.js`'s
 * `scoreBatch()`, etc.).
 */

/**
 * A predicted/actual quality delta at or under this magnitude counts as
 * 'accurate'. 0.1 is a deliberately loose bar for a first pass: predictions
 * come from a STATIC PRIOR (`profiling/predict.js`'s own docstring: "an
 * informed guess, not a measurement" until Phase 3's campaign has run), so
 * demanding tight agreement here would mostly measure how wrong the prior is,
 * not whether this comparison mechanism works. Named and exported so a later
 * phase — once learned curves exist — can tighten it with a stated reason
 * rather than a silent tweak.
 */
export const OUTCOME_ACCURATE_THRESHOLD = 0.1;

/**
 * Compare a batch's PRE-execution predicted quality
 * (`profiling/predict.js`'s `predictQuality()` return value's
 * `predictedQuality` field) against its POST-execution actual quality
 * (`quality/score.js`'s `scoreBatch()` return value's `combinedScore`
 * field).
 *
 * `delta` is signed as `actualQuality - predictedQuality`:
 *   - delta < 0  -> the prediction was HIGHER than what actually happened
 *                   -> 'over-predicted' (overconfident).
 *   - delta > 0  -> the prediction was LOWER than what actually happened
 *                   -> 'under-predicted' (overly pessimistic).
 *   - |delta| <= OUTCOME_ACCURATE_THRESHOLD -> 'accurate', regardless of sign.
 *
 * @param {number} predicted - `predictQuality()`'s `predictedQuality`.
 * @param {number} actual - `scoreBatch()`'s `combinedScore`.
 * @returns {{
 *   predictedQuality: number,
 *   actualQuality: number,
 *   delta: number,
 *   direction: 'over-predicted'|'under-predicted'|'accurate',
 *   accurateThreshold: number,
 *   withinTolerance: boolean
 * }}
 */
export function compareOutcome(predicted, actual) {
  const predictedQuality = Number.isFinite(predicted) ? predicted : 0;
  const actualQuality = Number.isFinite(actual) ? actual : 0;

  const delta = Number((actualQuality - predictedQuality).toFixed(4));
  const withinTolerance = Math.abs(delta) <= OUTCOME_ACCURATE_THRESHOLD;

  const direction = withinTolerance ? 'accurate' : delta < 0 ? 'over-predicted' : 'under-predicted';

  return {
    predictedQuality,
    actualQuality,
    delta,
    direction,
    accurateThreshold: OUTCOME_ACCURATE_THRESHOLD,
    withinTolerance
  };
}

/**
 * Attach a predicted-vs-actual comparison to an EXISTING route decision, for
 * ONE batch. `route-contracts.js`'s `buildRouteDecision()` already carries
 * `reasoning.rejectedReasons`, populated at construction time (before
 * execution ever happens) — `outcomeComparisons` cannot be filled in at that
 * same moment, since the batch has not run yet. This is the separate,
 * additive function that attaches it AFTER the fact, once
 * `compareOutcome()` has a real result for a given batch index.
 *
 * Returns a NEW object — never mutates `routeDecision` — matching this
 * codebase's "compute, don't mutate" convention (see e.g. `merge/index.js`'s
 * `mergeRoute()`, which always builds a fresh result rather than touching its
 * inputs). This is a genuinely separate function from `buildRouteDecision()`
 * itself: it does not change what that constructor accepts or returns, and
 * calling it never touches `buildRouteDecision()`'s own tests.
 *
 * @param {object} routeDecision - a `route-contracts.js` RouteDecision (or
 *   anything carrying a `reasoning` object — not required to be the exact
 *   shape `buildRouteDecision()` produces).
 * @param {number} batchIndex - which batch this comparison belongs to.
 * @param {ReturnType<typeof compareOutcome>} comparison
 * @returns {object} a new routeDecision-shaped object with
 *   `reasoning.outcomeComparisons[batchIndex]` populated.
 */
export function attachOutcomeComparison(routeDecision, batchIndex, comparison) {
  if (!routeDecision || typeof routeDecision !== 'object') {
    throw new Error('attachOutcomeComparison: routeDecision is required');
  }
  if (!Number.isInteger(batchIndex) || batchIndex < 0) {
    throw new Error('attachOutcomeComparison: batchIndex must be a non-negative integer');
  }
  if (!comparison || typeof comparison !== 'object') {
    throw new Error('attachOutcomeComparison: comparison is required (the compareOutcome() result)');
  }

  const existingComparisons = Array.isArray(routeDecision.reasoning?.outcomeComparisons)
    ? routeDecision.reasoning.outcomeComparisons.slice()
    : [];
  existingComparisons[batchIndex] = comparison;

  return {
    ...routeDecision,
    reasoning: {
      ...routeDecision.reasoning,
      outcomeComparisons: existingComparisons
    }
  };
}
