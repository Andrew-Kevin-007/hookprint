/**
 * policy/slash-policy.js — turning a real QUORUM signal into a real slash
 * amount, for BOTH trigger classes Kevin chose: (a) a provider's measured
 * quality outcome being bad, and (b) a provider's claim being directly
 * contradicted by another provider's claim at merge time. These are two
 * SEPARATE, distinctly-tagged classes (`SLASH_REASON_CLASSES` below) — never
 * folded into one generic "something went wrong" verdict, per Kevin's
 * explicit instruction.
 *
 * THE IDENTITY BRIDGE THIS FILE ASSUMES, STATED EXPLICITLY: in QUORUM's
 * dispatch pipeline, `provider` is normally an LLM vendor name ("anthropic",
 * "openai", ...) — see packages/dispatch/quality/score.js and
 * packages/dispatch/merge/consistency.js. There is no separate "agent
 * identity" concept in dispatch. This bridge treats whatever string
 * populates a scored event's / claim's `provider` field as the identity key
 * to look up in `identity-registry.js` — i.e. for staking purposes, the
 * `provider` string IS the agent's keyId. If a real deployment ever runs
 * several distinct staked agents behind the same vendor, the CALLER is
 * responsible for populating `provider` with the actual per-agent keyId
 * before invoking this policy layer, not a vendor name. That is a named
 * limitation of this bridge, not something fixed here.
 *
 * NEITHER `batch-quality-scored` EVENTS NOR DISPATCH'S OWN CLAIM OBJECTS
 * CARRY A `claimId` — that field name belongs to packages/align's Claim/
 * Delta contract, a different subsystem. AgentStake.sol's own comment says
 * `claimId` is "opaque" on-chain — any deterministic identifying string is
 * valid. This file synthesizes one per finding (see `synthesizeBatchClaimId`
 * / `synthesizeContradictionClaimId`) rather than pretending dispatch
 * produces one; that synthesis is itself part of the documented design.
 */

'use strict';

const SLASH_REASON_CLASSES = Object.freeze(['quality_failure', 'contradiction']);

/* -------------------------------------------------------------------------- */
/* Quality-failure policy                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Below this `combinedScore` (quality/score.js's `scoreBatch()` output,
 * `weights: {deterministic:0.35, consistency:0.65}`), a batch is judged a
 * quality failure worth slashing over.
 *
 * WHY 0.4, DOCUMENTED RATHER THAN FITTED: no historical ledger of real
 * `batch-quality-scored` events exists yet to fit a threshold against —
 * fabricating false precision from zero data would be worse than a round,
 * explainable number. 0.4 sits below the midpoint deliberately: a batch that
 * is merely mediocre on ONE half of the metric (e.g. deterministic ~0.5,
 * consistency ~0.5 -> combined 0.5) should not lose money — money is on the
 * line only once a batch is failing badly enough that ~0.35 deterministic +
 * ~0.65 consistency both trend toward "wrong" (e.g. ungrounded claims AND
 * net-contradicted by peers). Overridable per call via `thresholds.qualityFailureThreshold`.
 */
const QUALITY_FAILURE_THRESHOLD = 0.4;

/**
 * Slash-amount policy for a quality failure: linear in how far below
 * threshold the score fell, floor to ceiling. Deliberately simple — no
 * claimed precision beyond "worse scores slash more, up to a cap":
 *
 *   severity  = clamp((threshold - combinedScore) / threshold, 0, 1)   // 0 at the threshold, 1 at combinedScore=0
 *   amountEth = MIN + severity * (MAX - MIN)
 *
 * MIN_SLASH_AMOUNT_ETH (0.05): a batch that JUST crosses the threshold still
 * costs something real, not an amount that rounds away.
 * MAX_SLASH_AMOUNT_ETH (0.5): capped at half of the 1.0 ETH stake used in
 * scripts/demo-local.js / scripts/demo-policy.js, so a single bad batch can
 * cost an agent up to half its bond but never wipe it out in one verdict —
 * repeated failures compound instead of one score deciding everything.
 */
const MIN_SLASH_AMOUNT_ETH = 0.05;
const MAX_SLASH_AMOUNT_ETH = 0.5;

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/** Deterministic identifier for a whole-batch verdict — see file header. */
function synthesizeBatchClaimId({ provider, taskId, batchIndex }) {
  return `batch:${provider ?? 'unknown'}:${taskId ?? 'unknown-task'}:${Number.isFinite(batchIndex) ? batchIndex : 'unknown-index'}`;
}

/**
 * evaluateQualityFailure(qualityScoreEvent, { registry, thresholds })
 *
 * @param {object} qualityScoreEvent - a real `createLedgerEvent()`-shaped
 *   `'batch-quality-scored'` event: `{eventType, taskId, provider, routeId,
 *   payload:{batchIndex, contextRatio, deterministicScore, consistencyScore,
 *   combinedScore, weights, reasons}, timestamp}` — quality/score.js's
 *   `buildQualityScoreEvent()` output, verbatim.
 * @param {{registry, thresholds?:{qualityFailureThreshold?:number, minSlashEth?:number, maxSlashEth?:number}}} deps
 * @returns {{shouldSlash:boolean, agent:string|null, amountEth:number|0, claimId:string, reasonClass:'quality_failure', reason:string, combinedScore:number|null}}
 */
function evaluateQualityFailure(qualityScoreEvent, { registry, thresholds = {} } = {}) {
  const threshold = Number.isFinite(thresholds.qualityFailureThreshold) ? thresholds.qualityFailureThreshold : QUALITY_FAILURE_THRESHOLD;
  const minEth = Number.isFinite(thresholds.minSlashEth) ? thresholds.minSlashEth : MIN_SLASH_AMOUNT_ETH;
  const maxEth = Number.isFinite(thresholds.maxSlashEth) ? thresholds.maxSlashEth : MAX_SLASH_AMOUNT_ETH;

  const provider = qualityScoreEvent?.provider ?? null;
  const taskId = qualityScoreEvent?.taskId ?? null;
  const batchIndex = qualityScoreEvent?.payload?.batchIndex;
  const combinedScore = Number.isFinite(qualityScoreEvent?.payload?.combinedScore) ? qualityScoreEvent.payload.combinedScore : null;
  const claimId = synthesizeBatchClaimId({ provider, taskId, batchIndex });

  const base = { claimId, reasonClass: 'quality_failure', combinedScore };

  if (combinedScore === null) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: 'quality_score_missing_or_not_finite' };
  }

  if (combinedScore >= threshold) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: `combinedScore ${combinedScore.toFixed(4)} at or above threshold ${threshold}` };
  }

  // Below threshold. Only NOW does an unregistered identity matter -- never
  // attempt a slash against an unregistered agent, regardless of how bad
  // the score is.
  const evmAddress = registry ? registry.lookup(provider) : null;
  if (!evmAddress) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: 'agent_not_registered' };
  }

  const severity = clamp01((threshold - combinedScore) / threshold);
  const amountEth = Number((minEth + severity * (maxEth - minEth)).toFixed(4));

  return {
    ...base,
    shouldSlash: true,
    agent: evmAddress,
    amountEth,
    reason: `combinedScore ${combinedScore.toFixed(4)} below threshold ${threshold} (severity ${severity.toFixed(4)})`
  };
}

/* -------------------------------------------------------------------------- */
/* Contradiction policy                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Slash-amount policy for a CORROBORATED contradiction. Capped lower than a
 * quality failure (0.3 vs 0.5) because a contradiction verdict, even
 * corroborated, is one inferential step further removed from the agent's
 * own output than a direct quality failure is: the corroboration establishes
 * "more likely the wrong side," not the deterministic-checker-grade
 * certainty a quality failure carries against the agent's own batch.
 * Severity scales with `comparison.delta` (the relative disagreement
 * `merge/consistency.js`'s `compareClaims()` already computed for this exact
 * pair — bounded to [0,1] for same-signed ratio/absolute comparisons), same
 * linear floor-to-ceiling shape as the quality-failure policy above, for
 * the same reason: explainable, not fitted.
 */
const CONTRADICTION_MIN_SLASH_ETH = 0.05;
const CONTRADICTION_MAX_SLASH_ETH = 0.3;

function subjectSlug(subject) {
  return String(subject ?? 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Deterministic identifier for a contradiction verdict — see file header. */
function synthesizeContradictionClaimId(contradiction) {
  const a = contradiction?.claimA;
  const b = contradiction?.claimB;
  const subject = a?.claim?.subject ?? b?.claim?.subject;
  return `contradiction:${a?.provider ?? '?'}#${a?.batchIndex ?? '?'}:${b?.provider ?? '?'}#${b?.batchIndex ?? '?'}:${subjectSlug(subject)}`;
}

function sideKey(side) {
  return `${side?.provider}:${side?.batchIndex}`;
}

/**
 * Does `peer`'s claim have independent backing from a THIRD, distinct
 * (provider, batchIndex) source in `verification.agreements`? "Third" and
 * "distinct" both matter: an agreement entry pairing `peer` with `self`
 * itself would be a contradiction, not an agreement (compareClaims only
 * returns one relation per pair), so this only ever matches a genuinely
 * different source — but the explicit exclusion of `self` is kept anyway as
 * defense-in-depth against a malformed/synthetic `verification` object (as
 * hand-built by a test or the demo) rather than one produced by the real
 * `crossCheckBatches()`.
 */
function hasThirdPartyAgreement(peer, self, agreements) {
  return (Array.isArray(agreements) ? agreements : []).some((entry) => {
    const a = entry?.claimA;
    const b = entry?.claimB;
    const peerIsA = a?.provider === peer.provider && a?.batchIndex === peer.batchIndex;
    const peerIsB = b?.provider === peer.provider && b?.batchIndex === peer.batchIndex;
    if (!peerIsA && !peerIsB) return false;
    const other = peerIsA ? b : a;
    const otherIsSelf = other?.provider === self.provider && other?.batchIndex === self.batchIndex;
    const otherIsPeer = other?.provider === peer.provider && other?.batchIndex === peer.batchIndex;
    return !otherIsSelf && !otherIsPeer;
  });
}

/**
 * evaluateContradiction(contradiction, { registry, thresholds, verification, correlatedQualityFailures })
 *
 * THE DESIGN DECISION, DEFENDED IN FULL (this is the most architecturally
 * significant call in this module — see the task report for the extended
 * version of this argument):
 *
 * A contradiction between two claims proves the claims disagree. It does
 * NOT prove which one is false — that is exactly the trust boundary this
 * project states repeatedly (contracts/AgentStake.sol's own header: "It
 * cannot tell you whether any claim is true or false"; merge/consistency.js's
 * own header: "no authoritative side here"). Slashing "whichever side looks
 * different" from a bare contradiction alone is precisely the unjust
 * mechanism a prior threat-model review warned about: it would punish
 * whichever agent's true, correct claim happens to be the minority report
 * on a given batch, with zero evidence it was wrong.
 *
 * So: `shouldSlash: false` by default, `reason: 'contradiction_detected_no_ground_truth'`,
 * UNLESS a THIRD, independent signal exists that actually points at one
 * side. Two such signals are implemented, for real, not just named:
 *
 *   1. THIRD-PARTY AGREEMENT (the primary mechanism — fully derivable from
 *      `verification` alone, which is why this function's signature was
 *      widened to accept the FULL verification object rather than the one
 *      contradiction in isolation): if side X's peer (the OTHER side of
 *      this contradiction) is independently corroborated by a THIRD,
 *      distinct (provider, batchIndex) source in `verification.agreements`,
 *      that peer is more likely correct — which makes X, the side that
 *      disagreed with a now-corroborated peer, the more likely wrong one.
 *
 *   2. INDEPENDENT QUALITY FAILURE (secondary, optional — requires evidence
 *      this function cannot derive from `verification` alone, since
 *      `crossCheckBatches()`'s return value carries no quality-score data):
 *      if the CALLER already knows (from a separate, already-computed
 *      `evaluateQualityFailure()` result for one side's own batch) that a
 *      side independently failed quality on grounds that have nothing to do
 *      with this contradiction, that is real corroboration that THAT side
 *      is the wrong one. Supplied via the optional `correlatedQualityFailures`
 *      Set (keys `"provider:batchIndex"`) so this function's REQUIRED
 *      signature stays exactly `(contradiction, { registry, thresholds,
 *      verification })` and this mechanism only activates when a caller
 *      (see `evaluateBatchOutcome` below) actually has that evidence handy.
 *
 * If BOTH sides end up flagged by these mechanisms (a degenerate case not
 * expected from real data, but possible from an adversarial or malformed
 * `verification`), this function refuses to pick one — `shouldSlash: false`,
 * `reason: 'contradiction_corroboration_ambiguous_both_sides_flagged'` —
 * fail-closed, matching this codebase's convention everywhere else
 * (`executor/envelope.js`'s `parseEnvelope()`, `packages/align`'s ambiguous-
 * alignment refusal).
 *
 * @returns {{shouldSlash:boolean, agent:string|null, amountEth:number|0, claimId:string, reasonClass:'contradiction', reason:string}}
 */
function evaluateContradiction(contradiction, { registry, thresholds = {}, verification, correlatedQualityFailures } = {}) {
  const minEth = Number.isFinite(thresholds.contradictionMinSlashEth) ? thresholds.contradictionMinSlashEth : CONTRADICTION_MIN_SLASH_ETH;
  const maxEth = Number.isFinite(thresholds.contradictionMaxSlashEth) ? thresholds.contradictionMaxSlashEth : CONTRADICTION_MAX_SLASH_ETH;
  const claimId = synthesizeContradictionClaimId(contradiction);
  const base = { claimId, reasonClass: 'contradiction' };

  const a = contradiction?.claimA;
  const b = contradiction?.claimB;
  if (!a || !b) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: 'contradiction_missing_claimA_or_claimB' };
  }
  const sides = [a, b];
  const qualityFlagged = correlatedQualityFailures instanceof Set ? sides.filter((s) => correlatedQualityFailures.has(sideKey(s))) : [];
  const agreementFlagged = sides.filter((s) => {
    const peer = s === a ? b : a;
    return hasThirdPartyAgreement(peer, s, verification?.agreements);
  });

  const wrongSides = [];
  for (const s of [...qualityFlagged, ...agreementFlagged]) {
    if (!wrongSides.includes(s)) wrongSides.push(s);
  }

  if (wrongSides.length === 0) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: 'contradiction_detected_no_ground_truth' };
  }
  if (wrongSides.length > 1) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: 'contradiction_corroboration_ambiguous_both_sides_flagged' };
  }

  const wrong = wrongSides[0];
  const evmAddress = registry ? registry.lookup(wrong.provider) : null;
  if (!evmAddress) {
    return { ...base, shouldSlash: false, agent: null, amountEth: 0, reason: 'agent_not_registered' };
  }

  const delta = Number.isFinite(contradiction?.comparison?.delta) ? Math.max(0, Math.min(1, contradiction.comparison.delta)) : 1;
  const amountEth = Number((minEth + delta * (maxEth - minEth)).toFixed(4));
  const corroboratedBy = qualityFlagged.includes(wrong)
    ? 'contradiction_corroborated_by_independent_quality_failure'
    : 'contradiction_corroborated_by_third_party_agreement';

  return { ...base, shouldSlash: true, agent: evmAddress, amountEth, reason: corroboratedBy };
}

/* -------------------------------------------------------------------------- */
/* Per-batch orchestration                                                    */
/* -------------------------------------------------------------------------- */

/**
 * evaluateBatchOutcome({ qualityScoreEvent, verification, registry, thresholds })
 * -> [ ...evaluate* results that fired, zero or more ]
 *
 * Runs `evaluateQualityFailure()` once for `qualityScoreEvent`, then
 * `evaluateContradiction()` once for every contradiction present in
 * `verification.contradictions` — `verification` is expected to already be
 * scoped to what's relevant to this evaluation (the real `mergeRoute()`
 * output for one route, or, in a test/demo, a hand-built object containing
 * just the contradiction(s) under scrutiny). See `correlatedQualityFailures`
 * below for how the two mechanisms connect within one call.
 *
 * ORCHESTRATION NOTE, NAMED HONESTLY: if this function is ever wired to run
 * once per batch across a whole multi-batch route (the natural next
 * integration step, not built here), the SAME contradiction touches two
 * batches and would be evaluated twice — once from each batch's call.
 * `evaluateContradiction()` is a pure, symmetric function of (contradiction,
 * verification, ...): both calls compute the identical verdict, so this
 * does not double-slash a different agent or disagree with itself, but a
 * caller doing that full wiring must still deduplicate by `claimId` before
 * invoking `evaluateAndSlash()` twice for the same corroborated finding, or
 * it will submit two slash transactions for one verdict. Not built here —
 * this task's scope is the bridge and a single-call demo proving it works,
 * not the full per-route orchestration loop.
 *
 * @returns {Array<ReturnType<typeof evaluateQualityFailure>|ReturnType<typeof evaluateContradiction>>}
 */
function evaluateBatchOutcome({ qualityScoreEvent, verification, registry, thresholds } = {}) {
  const results = [];

  let qualityEval = null;
  if (qualityScoreEvent) {
    qualityEval = evaluateQualityFailure(qualityScoreEvent, { registry, thresholds });
    results.push(qualityEval);
  }

  const correlatedQualityFailures = new Set();
  if (qualityEval && qualityEval.shouldSlash) {
    correlatedQualityFailures.add(`${qualityScoreEvent.provider}:${qualityScoreEvent.payload?.batchIndex}`);
  }

  const contradictions = Array.isArray(verification?.contradictions) ? verification.contradictions : [];
  for (const contradiction of contradictions) {
    results.push(evaluateContradiction(contradiction, { registry, thresholds, verification, correlatedQualityFailures }));
  }

  return results;
}

module.exports = {
  SLASH_REASON_CLASSES,
  QUALITY_FAILURE_THRESHOLD,
  MIN_SLASH_AMOUNT_ETH,
  MAX_SLASH_AMOUNT_ETH,
  CONTRADICTION_MIN_SLASH_ETH,
  CONTRADICTION_MAX_SLASH_ETH,
  synthesizeBatchClaimId,
  synthesizeContradictionClaimId,
  evaluateQualityFailure,
  evaluateContradiction,
  evaluateBatchOutcome
};
