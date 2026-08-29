/**
 * predict.js — predict a batch's quality BEFORE executing it.
 *
 * This is "predict failure before it happens" made concrete (project plan,
 * Phase 5). For this pass there is no learned degradation curve yet — that
 * requires Phase 3's real measurement campaign, which has not run. So
 * `predictQuality()` does the honest thing available today:
 *
 *   1. Take provider-profiles.js's EXISTING static `qualityCurve` as the
 *      prior, using the exact same context-ratio thresholds
 *      `estimateProviderFit()` / `computeSafeBatchSize()` already use
 *      (> 0.9 → high-load band, > 0.6 → medium, else low).
 *   2. Adjust that prior by workload type, via a small, honestly-labeled
 *      multiplier table (see WORKLOAD_DEGRADATION_MULTIPLIERS below) — an
 *      informed guess, not a measurement, and documented as such.
 *   3. Always report `curveSource: 'static_prior'` in this pass.
 *
 * The prior lookup itself is a parameter (`curveLookup`), defaulting to the
 * static implementation here. A later phase can pass in a learned-curve
 * lookup fitted from real ledger data and flip the returned `curveSource` to
 * `'learned'` — additively, without changing this function's calling
 * contract or its callers.
 */

/**
 * Per-workload-type quality multiplier applied on top of the provider's
 * static quality-curve prior.
 *
 * THESE ARE INFORMED GUESSES, NOT MEASUREMENTS. Round numbers are
 * deliberate — 0.90 / 0.95 / 1.0 — so nobody mistakes them for a fitted
 * curve. The reasoning: workloads whose value depends on getting many small
 * details right at once (exact syntax across a file, consistent facts
 * across several documents) plausibly degrade faster as context grows than
 * a workload whose output tolerates more paraphrase (a summary). Phase 3's
 * measurement campaign is the thing that will tell us whether this guess is
 * even directionally correct — until then, this table is a documented prior,
 * not a claim.
 */
export const WORKLOAD_DEGRADATION_MULTIPLIERS = Object.freeze({
  code_analysis: 0.90,              // syntax/structure fidelity is the first thing to slip
  multi_document_comparison: 0.90,  // cross-item consistency is the first thing to slip
  reasoning: 0.95,                  // multi-step inference degrades, but more gracefully
  extraction: 0.95,                 // precise recall degrades, but more gracefully
  synthesis: 0.95,                  // combining sources degrades, but more gracefully
  summarization: 1.00               // least structure-sensitive workload; treated as baseline
});

/** Discount applied to prediction confidence because this pass has no learned curve. */
const STATIC_PRIOR_CONFIDENCE_DISCOUNT = 0.85;

/**
 * The static prior lookup — reads `provider-profiles.js`'s existing
 * `qualityCurve` using the SAME thresholds `estimateProviderFit()` already
 * uses in `route-contracts.js` (do not drift from those without updating
 * both places).
 *
 * @param {object} provider       A provider-profiles.js MODEL_PROFILES entry.
 * @param {number} contextRatio   perBatchTokens / contextWindow.
 * @returns {number} a quality estimate in [0, 1]
 */
export function staticPriorCurveLookup(provider, contextRatio) {
  const curve = provider?.qualityCurve ?? { low: 0.9, medium: 0.85, high: 0.75 };
  if (contextRatio > 0.9) return curve.high ?? 0.7;
  if (contextRatio > 0.6) return curve.medium ?? 0.8;
  return curve.low ?? 0.9;
}

/**
 * Predict a batch's quality before executing it.
 *
 * @param {object} task                       The route-contracts.js task (unused directly in
 *                                             this pass beyond being available to `curveLookup`
 *                                             overrides; kept in the signature so a learned-curve
 *                                             lookup can key off task-level fields later without
 *                                             changing this function's contract).
 * @param {object} provider                   A provider-profiles.js MODEL_PROFILES entry.
 * @param {object} workloadClassification     The `classifyWorkload()` result — needs
 *                                             `.workloadType` and `.confidence`.
 * @param {number} batchSize                  Items in this batch.
 * @param {(provider: object, contextRatio: number, task?: object) => number} [curveLookup]
 *   Optional prior lookup override — the swap-point a later phase uses to plug in a real
 *   learned curve without rewriting this function. Defaults to `staticPriorCurveLookup`.
 * @returns {{ predictedQuality: number, confidence: number, basis: string,
 *             curveSource: 'static_prior'|'learned' }}
 */
export function predictQuality(task, provider, workloadClassification, batchSize, curveLookup = staticPriorCurveLookup) {
  const tokensPerItem = provider?.tokensPerItem ?? 2000;
  const contextWindow = provider?.contextWindow ?? 100000;
  const safeBatchSize = Math.max(1, Number.isFinite(batchSize) ? batchSize : 1);
  const contextRatio = (tokensPerItem * safeBatchSize) / contextWindow;

  const basePrior = curveLookup(provider, contextRatio, task);

  const workloadType = workloadClassification?.workloadType ?? 'summarization';
  const multiplier = WORKLOAD_DEGRADATION_MULTIPLIERS[workloadType] ?? 1.0;

  const predictedQuality = clamp01(basePrior * multiplier);

  // Prediction confidence blends how sure the workload classifier was with a
  // fixed discount for the fact this is a static prior, not a learned curve —
  // never claim full confidence when the underlying curve is a documented guess.
  const classificationConfidence = Number.isFinite(workloadClassification?.confidence)
    ? workloadClassification.confidence
    : 0.5;
  const confidence = clamp01(classificationConfidence * STATIC_PRIOR_CONFIDENCE_DISCOUNT);

  const basis = `static prior ${basePrior.toFixed(3)} for provider '${provider?.name ?? 'unknown'}' ` +
    `at context ratio ${contextRatio.toFixed(3)}, adjusted by workload '${workloadType}' ` +
    `multiplier ${multiplier}`;

  return {
    predictedQuality: Number(predictedQuality.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    basis,
    // Always 'static_prior' in this pass — there is no learned curve yet.
    // A later phase passing a real learned `curveLookup` should also flip
    // this literal to 'learned'; the parameter shape already supports the
    // swap without touching callers.
    curveSource: 'static_prior'
  };
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
