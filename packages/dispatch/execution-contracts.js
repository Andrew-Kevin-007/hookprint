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
  'merge-incomplete'
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

export function buildDashboardSnapshot({ taskRouteDecisions = [], providerProfiles = [] } = {}) {
  const routes = Array.isArray(taskRouteDecisions) ? taskRouteDecisions : [];
  const providers = Array.isArray(providerProfiles) ? providerProfiles : [];

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
    }))
  };
}
