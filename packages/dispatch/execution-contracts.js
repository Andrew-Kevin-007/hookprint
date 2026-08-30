export const LEDGER_EVENT_TYPES = [
  'task-created',
  'task-routed',
  'task-executed',
  'task-completed',
  'task-failed',
  'task-fallback',
  'provider-health-update',
  'prediction-recorded',
  'reputation-updated',
  // The merge step (merge/index.js) — one event type per mergeRoute() status,
  // the same "one type per outcome" convention task-completed/task-failed
  // already use for EXECUTION_STATUS. 'merge-incomplete' is its own type
  // (not folded into 'task-failed') because a batch can fail HERE — a
  // successful API call whose output didn't match the required envelope
  // schema — in a way executor/index.js's outcome.status never observes;
  // that is itself a real reputation signal (a provider ignoring the
  // schema), not a hidden defect.
  'merge-completed',
  'merge-contradiction-found',
  'merge-incomplete',
  // Phase 2 (quality/score.js) — one batch's hybrid deterministic +
  // cross-batch-consistency score, recorded alongside its `contextRatio`.
  // This is the observation Phase 3's measurement campaign and Phase 4's
  // learned degradation curves are built on top of (quality as a function
  // of context load, per provider) — see quality/score.js's
  // `buildQualityScoreEvent()` for the exact payload contract.
  'batch-quality-scored',
  // Phase 3 (bench/degradation/) — one measurement-campaign cell (a single
  // provider/batchSize/repetition combination) has finished executing,
  // scoring, and being logged. Additive: a superset of what a single
  // 'batch-quality-scored' event already carries (this event's own
  // `taskId` is the deterministic `campaign-<provider>-bs<N>-r<rep>` id,
  // which is ALSO what makes the campaign runner's resumability check a
  // plain `readEvents(ledgerPath, { eventType: 'campaign-cell-completed',
  // taskId })` lookup rather than bespoke matching logic) plus the fields
  // a later curve-fit needs that aren't otherwise co-located: batchSize,
  // repetition, and the raw execution status (so a quota/timeout/error
  // cell is distinguishable from one that never ran at all). See
  // bench/degradation/runner.js's `runCampaignCell()` for the exact
  // payload shape.
  'campaign-cell-completed',
  // Phase 7 (live dashboard wiring, bin/quorum.js's `quorum run`): one real
  // route decision, DASHBOARD-shaped. `dispatcher/policy.js`'s
  // `decideRoute()` already writes a THIN 'task-routed' event via its own
  // `logRouteDecision()` (payload: approved/operatorOverride/decisionPath/
  // reason only) — that event exists for policy audit, not for dashboard
  // rendering, and does not carry selectedProvider/qualityTarget/
  // confidence/batchPlan/fallbackProvider/riskLevel. This is deliberately a
  // SEPARATE event type rather than overloading 'task-routed' with a second,
  // incompatible payload shape (a reader would otherwise have to guess which
  // of two shapes a given 'task-routed' row carries). Payload is exactly
  // `dispatcher/policy.js`'s `toDashboardEntry(decision)` return value (a
  // `buildRouteLedgerEntry()` shape) — pure reuse, no new shaping logic.
  'route-decision-recorded',
  // Phase 7: one real signed execution trace (`trace/index.js`'s
  // `assembleExecutionTrace()` + `signExecutionTrace()`) has been produced
  // for a task. No existing type fits "a whole trace was assembled and
  // signed" — the closest neighbors ('merge-completed'/
  // 'merge-contradiction-found'/'merge-incomplete') are written earlier in
  // the pipeline, before the trace exists, and carry no traceId/attestation.
  // See bin/quorum.js's `cmdRun()` for the real payload shape (traceId,
  // status/contradictionCount/agreementCount/unmatchedCount,
  // meanOutcomeAccuracy, assembledAt, attestation, verified).
  'execution-trace-recorded'
];

export function createLedgerEvent({ eventType, taskId, provider, routeId, payload = {}, timestamp = new Date().toISOString() }) {
  if (!LEDGER_EVENT_TYPES.includes(eventType)) {
    throw new Error(`Unsupported ledger event type: ${eventType}`);
  }

  return {
    eventType,
    taskId: taskId ?? `task-${Date.now()}`,
    provider: provider ?? null,
    routeId: routeId ?? null,
    payload: payload ?? {},
    timestamp
  };
}

/**
 * buildRouteLedgerEntry()
 *
 * NOTE: originally named buildRouteDecision() — renamed to remove a duplicate
 * export collision with route-contracts.js's buildRouteDecision(), which is a
 * different, richer shape (decisionId, reasoning{}, fallbackProviders[]). Any
 * module needing both would hit a duplicate-binding error importing both under
 * the same name. This function is semantically distinct: a flat, serializable
 * LOG entry of a route decision for the ledger/dashboard, not the decision
 * object itself. In real use this is built FROM a route-contracts.js
 * RouteDecision, not as a competing definition of one.
 */
export function buildRouteLedgerEntry({
  taskId,
  selectedProvider,
  qualityTarget,
  confidence,
  batchPlan,
  fallbackProvider,
  reason,
  riskLevel = 'low',
  createdAt = new Date().toISOString()
}) {
  return {
    taskId: taskId ?? `task-${Date.now()}`,
    selectedProvider: selectedProvider ?? 'openai',
    qualityTarget: Number.isFinite(qualityTarget) ? qualityTarget : 0.85,
    confidence: Number.isFinite(confidence) ? confidence : 0.8,
    batchPlan: Array.isArray(batchPlan) ? batchPlan : [],
    fallbackProvider: fallbackProvider ?? null,
    reason: reason ?? 'provider-fit-and-safe-batch-window',
    riskLevel,
    createdAt
  };
}

/**
 * Summarize one execution trace's `outcomeComparisons` (see `trace/outcome.js`'s
 * `compareOutcome()`) into a single dashboard-friendly number: the mean of
 * `1 - |delta|` across every comparison that carries a finite `delta`,
 * clamped so a single wildly-off batch cannot push the mean below 0. `null`
 * when there is nothing to summarize (no comparisons at all) — never a
 * fabricated 0 or 1, matching this codebase's fail-closed "explicit missing
 * marker, never a bare misleading number" convention (see e.g.
 * `ledger/reputation.js`'s `computeTrustScore()`).
 */
function computeMeanOutcomeAccuracy(outcomeComparisons) {
  const list = Array.isArray(outcomeComparisons) ? outcomeComparisons : [];
  const perComparisonAccuracy = list
    .filter((c) => Number.isFinite(c?.delta))
    .map((c) => Math.max(0, 1 - Math.abs(c.delta)));

  if (perComparisonAccuracy.length === 0) return null;
  const mean = perComparisonAccuracy.reduce((sum, v) => sum + v, 0) / perComparisonAccuracy.length;
  return Number(mean.toFixed(4));
}

/**
 * @param {object} args
 * @param {object[]} [args.taskRouteDecisions]
 * @param {object[]} [args.providerProfiles]
 * @param {object[]} [args.executionTraces] - Phase 6 additive: `trace/index.js`'s
 *   `assembleExecutionTrace()` results. Omitted (the default, `[]`) — every
 *   pre-existing field (`summary`/`routes`/`providerHealth`) is computed
 *   EXACTLY as before this parameter existed; only the new `traces: []` field
 *   is attached, additively, alongside them.
 * @param {object[]} [args.degradationCurves] - Phase 6 additive:
 *   `ledger/curves.js`'s `fitDegradationCurve()` results, one per provider.
 *   Same additive/omittable contract as `executionTraces` above.
 */
export function buildDashboardSnapshot({
  taskRouteDecisions = [],
  providerProfiles = [],
  executionTraces = [],
  degradationCurves = []
} = {}) {
  const routes = Array.isArray(taskRouteDecisions) ? taskRouteDecisions : [];
  const providers = Array.isArray(providerProfiles) ? providerProfiles : [];
  const traces = Array.isArray(executionTraces) ? executionTraces : [];
  const curves = Array.isArray(degradationCurves) ? degradationCurves : [];

  const totalTasks = routes.length;
  const avgConfidence = routes.length
    ? routes.reduce((sum, route) => sum + Number(route.confidence ?? 0), 0) / routes.length
    : 0;
  const highRisk = routes.filter((route) => (route.riskLevel ?? 'low') === 'high').length;

  return {
    summary: {
      totalTasks,
      avgConfidence: Number(avgConfidence.toFixed(3)),
      highRisk,
      providerCount: providers.length
    },
    routes: routes.map((route) => ({
      taskId: route.taskId,
      selectedProvider: route.selectedProvider,
      qualityTarget: route.qualityTarget,
      confidence: route.confidence,
      riskLevel: route.riskLevel ?? 'low',
      batchCount: Array.isArray(route.batchPlan) ? route.batchPlan.length : 0,
      fallbackProvider: route.fallbackProvider ?? null
    })),
    providerHealth: providers.map((provider) => ({
      name: provider.name ?? 'unknown',
      safeBatch: provider.safeBatch ?? 0,
      qualityEstimate: provider.qualityEstimate ?? 0,
      totalBatches: provider.totalBatches ?? 1
    })),
    // Phase 6 additive fields — summarized, never the raw trace/curve object
    // (a raw trace could carry, e.g., a full `reasoning` blob; the dashboard
    // gets only what it needs to render).
    traces: traces.map((t) => ({
      traceId: t?.traceId ?? null,
      status: t?.merge?.status ?? null,
      contradictionCount: Number.isFinite(t?.merge?.contradictionCount) ? t.merge.contradictionCount : 0,
      meanOutcomeAccuracy: computeMeanOutcomeAccuracy(t?.outcomeComparisons)
    })),
    degradation: curves.map((c) => ({
      provider: c?.provider ?? null,
      sampleCount: Number.isFinite(c?.sampleCount) ? c.sampleCount : 0,
      confidence: c?.confidence ?? 'none',
      method: c?.method ?? 'insufficient_data',
      curve: c?.curve ?? null
    }))
  };
}
