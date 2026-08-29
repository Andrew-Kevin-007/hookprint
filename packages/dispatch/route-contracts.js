import { classifyWorkload } from './profiling/classify.js';

export function buildTaskRequest(input = {}) {
  const task = {
    // Identification
    taskId: input.taskId ?? `task-${Date.now()}`,
    kind: input.kind ?? 'document-analysis', // document-analysis, code-review, summarization, etc.
    
    // Content
    items: Array.isArray(input.items) ? input.items.slice() : [], // array of { id, content, tokens? }
    
    // Quality & Routing Constraints
    qualityTarget: Number.isFinite(input.qualityTarget) ? input.qualityTarget : 0.85, // 0.7–0.95
    qualityTargetReason: input.qualityTargetReason ?? 'default', // e.g., 'high-stakes', 'exploratory', 'user-facing'
    
    // Provider Preferences
    providerPreference: Array.isArray(input.providerPreference) ? input.providerPreference.slice() : [], // ordered list of provider names
    blockedProviders: Array.isArray(input.blockedProviders) ? input.blockedProviders.slice() : [], // compliance/privacy constraints
    
    // Budget & Performance
    latencyBudgetMs: Number.isFinite(input.latencyBudgetMs) ? input.latencyBudgetMs : 30000,
    costBudget: Number.isFinite(input.costBudget) ? input.costBudget : Number.POSITIVE_INFINITY,
    
    // Execution Policy
    contextResetRequired: input.contextResetRequired ?? true, // fresh context for each batch
    safeMode: input.safeMode ?? true, // fail-safe if quality cannot be guaranteed
    allowManualOverride: input.allowManualOverride ?? false, // operator can override route selection
    
    // Optional: External Agent Prediction
    agentPrediction: input.agentPrediction ? {
      provider: input.agentPrediction.provider ?? 'unknown',
      confidence: Number.isFinite(input.agentPrediction.confidence) ? input.agentPrediction.confidence : 0.5,
      recommendedBatchSize: Number.isFinite(input.agentPrediction.recommendedBatchSize) ? input.agentPrediction.recommendedBatchSize : null,
      fallbackReason: input.agentPrediction.fallbackReason ?? null,
      predictionContext: input.agentPrediction.predictionContext ?? null // e.g., task size analysis
    } : null,
    
    // Metadata
    createdAt: input.createdAt ?? new Date().toISOString(),
    externalRef: input.externalRef ?? null // e.g., trace-id, correlation-id
  };

  return task;
}

export function estimateProviderFit(task, provider) {
  const itemCount = Math.max(1, task.items.length || 1);
  const tokensPerItem = provider.tokensPerItem ?? 2000;
  const contextWindow = provider.contextWindow ?? 100000;
  const safeContextRatio = provider.safeContextRatio ?? 0.6;
  const maxBatchSize = provider.maxBatchSize ?? 25;
  const safeBatch = Math.max(
    1,
    Math.min(
      maxBatchSize,
      Math.floor((contextWindow * safeContextRatio) / tokensPerItem)
    )
  );

  const batchSize = Math.min(safeBatch, itemCount);
  const totalBatches = Math.max(1, Math.ceil(itemCount / batchSize));
  const estimatedTokens = tokensPerItem * itemCount;
  const perBatchTokens = tokensPerItem * batchSize;
  const contextRatio = perBatchTokens / contextWindow;
  const qualityCurve = provider.qualityCurve ?? { low: 0.9, medium: 0.85, high: 0.75 };

  const qualityEstimate = contextRatio > 0.9
    ? qualityCurve.high ?? 0.7
    : contextRatio > 0.6
      ? qualityCurve.medium ?? 0.8
      : qualityCurve.low ?? 0.9;

  return {
    provider: provider.name,
    totalBatches,
    batchSize,
    qualityEstimate,
    estimatedTokens,
    contextRatio
  };
}

export function planBatches(task, providers = []) {
  const normalizedTask = buildTaskRequest(task);
  const safeProviders = Array.isArray(providers) ? providers : [];

  if (safeProviders.length === 0) {
    return [];
  }

  return safeProviders
    .map((provider) => {
      const fit = estimateProviderFit(normalizedTask, provider);
      const batchSize = Math.max(1, Math.min(fit.batchSize, provider.maxBatchSize ?? fit.batchSize));
      const totalBatches = Math.max(1, Math.ceil(normalizedTask.items.length / batchSize));
      const qualityEstimate = fit.qualityEstimate;

      return {
        provider: provider.name,
        batchSize,
        totalBatches,
        qualityEstimate,
        estimatedTokens: fit.estimatedTokens,
        contextRatio: fit.contextRatio,
        contextResetRequired: normalizedTask.contextResetRequired
      };
    })
    .sort((a, b) => {
      const qualityDelta = b.qualityEstimate - a.qualityEstimate;
      if (qualityDelta !== 0) return qualityDelta;
      return a.estimatedTokens - b.estimatedTokens;
    });
}

/**
 * analyzeTaskQuality()
 * 
 * Fallback quality prediction when no external agent is available.
 * Used to set or validate the qualityTarget if not explicitly declared.
 * 
 * This is the assistant-owned heuristic; Claude's provider execution layer
 * may replace with a more sophisticated model.
 */
export function analyzeTaskQuality(task) {
  const normalized = buildTaskRequest(task);
  
  // If quality target is already set, return it with confidence
  if (Number.isFinite(normalized.qualityTarget) && normalized.qualityTarget > 0) {
    return {
      qualityTarget: normalized.qualityTarget,
      reason: normalized.qualityTargetReason || 'explicit',
      confidence: 1.0, // user-declared
      prediction: null
    };
  }

  // Heuristic: infer quality target from item count and kind
  const itemCount = normalized.items?.length ?? 0;
  let inferredTarget = 0.85; // default moderate quality
  let reason = 'default-moderate';

  // Small tasks (1–5 items): can afford higher quality
  if (itemCount <= 5) {
    inferredTarget = 0.9;
    reason = 'small-task';
  }
  // Medium tasks (5–20 items): moderate quality
  else if (itemCount <= 20) {
    inferredTarget = 0.85;
    reason = 'medium-task';
  }
  // Large tasks (20+ items): accept lower quality to avoid timeout/cost explosion
  else {
    inferredTarget = 0.75;
    reason = 'large-task';
  }

  // Adjust by kind
  if (normalized.kind === 'code-review' || normalized.kind === 'security-audit') {
    inferredTarget = Math.min(0.95, inferredTarget + 0.05); // high stakes
    reason = normalized.kind;
  } else if (normalized.kind === 'brainstorm' || normalized.kind === 'exploratory') {
    inferredTarget = Math.max(0.65, inferredTarget - 0.15); // exploratory, can be lower
    reason = normalized.kind;
  }

  // Real workload-type classification (profiling/classify.js), closing the
  // gap this heuristic used to paper over with two hardcoded `kind` checks.
  const workload = classifyWorkload(normalized);

  return {
    qualityTarget: Math.max(0.65, Math.min(0.95, inferredTarget)),
    reason,
    confidence: 0.7, // heuristic estimate
    prediction: {
      itemCount,
      kind: normalized.kind,
      safeMode: normalized.safeMode,
      // Additive fields from the real workload taxonomy.
      workloadType: workload.workloadType,
      workloadConfidence: workload.confidence,
      workloadSignals: workload.signals
    }
  };
}

/**
 * buildRouteDecision()
 * 
 * Constructs the final route decision object that dispatcher will execute.
 * Includes: which provider, batch plan, quality expectation, fallback chain, 
 * decision log, and audit trail.
 */
export function buildRouteDecision(input = {}) {
  const decision = {
    // Decision ID and timestamp
    decisionId: input.decisionId ?? `route-${Date.now()}`,
    taskId: input.taskId ?? 'unknown',
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    
    // Primary route
    primaryProvider: input.primaryProvider ?? 'unknown',
    batchPlan: input.batchPlan ?? [], // array of { batchIndex, itemIds, expectedTokens }
    qualityTarget: Number.isFinite(input.qualityTarget) ? input.qualityTarget : 0.85,
    
    // Fallback chain (if primary fails)
    fallbackProviders: Array.isArray(input.fallbackProviders) ? input.fallbackProviders.slice() : [],
    fallbackThreshold: Number.isFinite(input.fallbackThreshold) ? input.fallbackThreshold : 0.65,
    
    // Execution parameters
    contextResetRequired: input.contextResetRequired ?? true,
    safeMode: input.safeMode ?? true,
    operatorOverride: input.operatorOverride ?? false,
    
    // Decision rationale (for audit and debugging)
    reasoning: input.reasoning ?? {
      selectedReason: 'quality-optimal',
      alternativeProviders: [],
      rejectedReasons: {}
    },
    
    // Metadata
    externalRef: input.externalRef ?? null // trace-id or correlation-id for linking
  };

  return decision;
}

