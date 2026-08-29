export const MODEL_PROFILES = {
  anthropic: {
    name: 'anthropic',
    contextWindow: 200000,
    safeContextRatio: 0.62,
    tokensPerItem: 2500,
    maxBatchSize: 35,
    qualityCurve: {
      low: 0.94,
      medium: 0.9,
      high: 0.82
    }
  },
  openai: {
    name: 'openai',
    contextWindow: 128000,
    safeContextRatio: 0.6,
    tokensPerItem: 2300,
    maxBatchSize: 30,
    qualityCurve: {
      low: 0.92,
      medium: 0.88,
      high: 0.77
    }
  },
  local: {
    name: 'local',
    contextWindow: 8000,
    safeContextRatio: 0.5,
    tokensPerItem: 1800,
    maxBatchSize: 8,
    qualityCurve: {
      low: 0.84,
      medium: 0.75,
      high: 0.66
    }
  }
};

export function getProviderProfile(providerName) {
  const source = (providerName ?? '').toLowerCase();
  return MODEL_PROFILES[source] ?? MODEL_PROFILES.openai;
}

export function computeSafeBatchSize(provider, itemCount = 1) {
  const profile = provider ?? MODEL_PROFILES.openai;
  const tokensPerItem = profile.tokensPerItem ?? 2000;
  const contextWindow = profile.contextWindow ?? 100000;
  const safeContextRatio = profile.safeContextRatio ?? 0.6;
  const maxBatchSize = profile.maxBatchSize ?? 25;

  const estimatedSafe = Math.max(
    1,
    Math.min(
      maxBatchSize,
      Math.floor((contextWindow * safeContextRatio) / tokensPerItem)
    )
  );

  return Math.min(estimatedSafe, Math.max(1, itemCount));
}

export function rankProviders(task, providerList = []) {
  const taskItems = Array.isArray(task?.items) ? task.items : [];
  const candidates = Array.isArray(providerList) ? providerList : Object.values(MODEL_PROFILES);

  return candidates
    .map((provider) => {
      const safeBatch = computeSafeBatchSize(provider, taskItems.length || 1);
      const totalBatches = Math.max(1, Math.ceil((taskItems.length || 1) / safeBatch));
      const estimatedTokens = (provider.tokensPerItem ?? 2000) * (taskItems.length || 1);
      const profileQuality = provider.qualityCurve ?? { low: 0.88, medium: 0.8, high: 0.72 };
      const qualityEstimate = totalBatches <= 2 ? profileQuality.low : totalBatches <= 4 ? profileQuality.medium : profileQuality.high;

      return {
        provider: provider.name,
        safeBatch,
        totalBatches,
        estimatedTokens,
        qualityEstimate,
        contextResetRequired: true
      };
    })
    .sort((a, b) => b.qualityEstimate - a.qualityEstimate || a.totalBatches - b.totalBatches);
}
