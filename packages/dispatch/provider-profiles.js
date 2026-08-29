import { fitDegradationCurve } from './ledger/curves.js';

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
  },

  // --- Free-tier providers added for the routing/execution demo. ---
  // None of these four have a measured `qualityCurve` yet (that requires
  // Phase 3's real measurement campaign) — each reuses the exact 'local'
  // curve shape above verbatim as a documented conservative PRIOR, per the
  // task brief's explicit instruction not to fabricate a confident-looking
  // curve for a provider with no real data. `tokensPerItem`/`maxBatchSize`
  // are likewise estimates in the same style/order of magnitude as the
  // anthropic/openai entries above, not measurements.
  //
  // `rateLimits` is a new field these four entries add (anthropic/openai/
  // local have no equivalent — there is nothing consistent to extend there,
  // since this project holds no published free-tier quota for a paid
  // Anthropic/OpenAI key). Shape: `{ rpm, rpd, tpm, tpd }`, any of which may
  // be `null` when the provider does not publish that particular ceiling.
  // Every figure below is the provider's OWN published number as of the
  // check date noted per-provider, not an estimate — but free-tier quotas
  // shift often, so treat these as a verified starting point, not a
  // permanent constant (this is also why Phase 4's ledger-based reputation
  // system exists: to observe the REAL limits over time rather than trust
  // any static table indefinitely).
  groq: {
    name: 'groq',
    // llama-3.3-70b-versatile: confirmed still listed as a production model
    // at console.groq.com/docs/models (checked 2026-08-29). Context window
    // 131072 per Groq's own model page (matches Meta's published Llama 3.3
    // spec).
    contextWindow: 131072,
    safeContextRatio: 0.6,
    tokensPerItem: 2200,
    maxBatchSize: 32,
    qualityCurve: {
      low: 0.84,
      medium: 0.75,
      high: 0.66
    },
    // console.groq.com/docs/rate-limits now serves account-specific limits
    // only ("view current, exact rate limits ... in your account settings")
    // and no longer publishes a static table for this model — these figures
    // are the consistent, converging value across multiple independent
    // third-party trackers as of 2026-08-29 (no official static citation
    // available for this exact model at this exact date; re-verify against
    // your own account's limits page before depending on this for capacity
    // planning).
    rateLimits: { rpm: 30, rpd: 1000, tpm: 12000, tpd: 100000 }
  },
  cerebras: {
    name: 'cerebras',
    // MODEL NOTE: the task brief expected `llama-3.3-70b` here. As of this
    // check (2026-08-29), Cerebras's public model catalog
    // (inference-docs.cerebras.ai/models/overview) lists NO Llama model at
    // all — only `gpt-oss-120b` and `gemma-4-31b` are on the public/free
    // catalog now (a real, observed catalog change, not a guess; see the
    // matching note in executor/cerebras.js). Profile below models
    // `gpt-oss-120b`, the larger of the two. Context window 65536 is the
    // FREE-tier cap per the same page (131072 on paid).
    contextWindow: 65536,
    safeContextRatio: 0.55,
    tokensPerItem: 2200,
    maxBatchSize: 16,
    qualityCurve: {
      low: 0.84,
      medium: 0.75,
      high: 0.66
    },
    // Source: inference-docs.cerebras.ai/support/rate-limits (official,
    // fetched 2026-08-29) — the one provider here whose official docs still
    // publish a static per-model table. `gpt-oss-120b` free tier: 5 RPM,
    // 30K TPM, 1M TPH, 1M TPD. No published requests/day ceiling — Cerebras
    // rate-limits this tier by token volume, not request count, so `rpd`
    // is `null` rather than a guessed number.
    rateLimits: { rpm: 5, rpd: null, tpm: 30000, tpd: 1000000 }
  },
  gemini: {
    name: 'gemini',
    // MODEL NOTE: the task brief expected `gemini-2.0-flash`. As of this
    // check (2026-08-29), ai.google.dev/gemini-api/docs/models lists
    // gemini-2.0-flash as SHUT DOWN. `gemini-2.5-flash` is the closest
    // still-live equivalent (see the matching note in executor/gemini.js
    // for why the newer gemini-3.7-flash was not chosen instead). Context
    // window 1048576 confirmed current for gemini-2.5-flash.
    contextWindow: 1048576,
    safeContextRatio: 0.65,
    tokensPerItem: 2500,
    maxBatchSize: 60,
    qualityCurve: {
      low: 0.84,
      medium: 0.75,
      high: 0.66
    },
    // ai.google.dev/gemini-api/docs/rate-limits (official, fetched
    // 2026-08-29) states limits are now account/tier-specific and viewable
    // only in AI Studio's console — it publishes no public static number.
    // Figures below are the converging value across independent third-party
    // trackers as of the same date; re-verify in your own AI Studio console
    // (aistudio.google.com/rate-limit) before depending on this.
    rateLimits: { rpm: 15, rpd: 1500, tpm: 1000000, tpd: null }
  },
  openrouter: {
    name: 'openrouter',
    // MODEL NOTE: the task brief's example (`meta-llama/...:free`) is not
    // currently free on OpenRouter — verified by querying the real,
    // unauthenticated `GET https://openrouter.ai/api/v1/models` endpoint
    // directly on 2026-08-29 and filtering `id` ending in `:free`: 18 free
    // models are live, none are Llama. `google/gemma-4-31b-it:free` is used
    // instead (262144 context, `pricing.prompt`/`pricing.completion` both
    // "0" in that live response) — the same base model Cerebras also serves
    // free right now, which is corroborating evidence it's a real current
    // offering rather than a one-source fluke. OpenRouter's free catalog is
    // documented to rotate; re-query the endpoint above before depending on
    // this default.
    contextWindow: 262144,
    safeContextRatio: 0.55,
    tokensPerItem: 2200,
    maxBatchSize: 40,
    qualityCurve: {
      low: 0.84,
      medium: 0.75,
      high: 0.66
    },
    // Source: openrouter.ai/docs/api-reference/limits (official, fetched
    // 2026-08-29) — the only figures in this whole set confirmed on an
    // official page with an exact static number, matching the task brief's
    // own estimate. Free-model variants: 20 RPM always; 50 requests/day
    // normally, rising to 1000/day once the account has purchased $10+ in
    // lifetime credits. No published token ceiling (limited by request
    // count, not tokens), so `tpd`/`tpm` are `null`.
    rateLimits: { rpm: 20, rpd: 50, rpdWithCredits: 1000, tpm: null, tpd: null }
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

/**
 * @param {object} task
 * @param {object[]} [providerList]
 * @param {{ledgerPath?: string}} [opts] - OMITTED (the default): behaves
 *   EXACTLY as before this phase -- no ledger read attempted, zero behavior
 *   change, zero cost for existing callers. When `opts.ledgerPath` IS given,
 *   each provider's quality estimate tries `ledger/curves.js`'s
 *   `fitDegradationCurve()` first and uses the LEARNED value for whichever
 *   bucket (low/medium/high) this call would have used, falling back to the
 *   existing static `qualityCurve` value bucket-by-bucket (not all-or-
 *   nothing for the whole provider) wherever the learned curve has no
 *   sufficient data for that specific bucket -- see curves.js's own
 *   docstring for what "sufficient" means.
 */
export function rankProviders(task, providerList = [], opts = {}) {
  const taskItems = Array.isArray(task?.items) ? task.items : [];
  const candidates = Array.isArray(providerList) ? providerList : Object.values(MODEL_PROFILES);
  const ledgerPath = opts?.ledgerPath;

  return candidates
    .map((provider) => {
      const safeBatch = computeSafeBatchSize(provider, taskItems.length || 1);
      const totalBatches = Math.max(1, Math.ceil((taskItems.length || 1) / safeBatch));
      const estimatedTokens = (provider.tokensPerItem ?? 2000) * (taskItems.length || 1);
      const staticQuality = provider.qualityCurve ?? { low: 0.88, medium: 0.8, high: 0.72 };

      let profileQuality = staticQuality;
      if (ledgerPath) {
        const fit = fitDegradationCurve(ledgerPath, provider.name);
        if (fit.curve) {
          profileQuality = {
            low: fit.curve.low ?? staticQuality.low,
            medium: fit.curve.medium ?? staticQuality.medium,
            high: fit.curve.high ?? staticQuality.high
          };
        }
      }

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
