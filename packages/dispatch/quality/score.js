/**
 * QUORUM dispatch — quality/score.js
 *
 * Phase 2 (plan §"Quality scoring"): the metric Kevin explicitly chose — a
 * HYBRID of deterministic checks plus cross-batch consistency, producing ONE
 * number per batch. Later phases (Phase 3's measurement campaign, Phase 4's
 * learned reputation curves) are built directly on top of the shape this
 * module produces, in particular `buildQualityScoreEvent()`'s payload — see
 * that function's docstring for the exact contract.
 *
 * Two independent halves, combined at the bottom of this file:
 *   - `scoreDeterministic()` — envelope validity, non-degenerate fields, no
 *     truncation, and anti-hallucination grounding, using ONLY this batch's
 *     own envelope + its own input content. No knowledge of any other batch.
 *   - `scoreConsistency()` — what fraction of THIS batch's claims survived
 *     `merge/consistency.js`'s cross-batch peer check. Requires the whole
 *     route's `verification` object (`crossCheckBatches()`'s return value),
 *     since "survived" is only meaningful relative to peers.
 */

import { tokenize, contentStems } from '../../align/text.js';
import { createLedgerEvent } from '../execution-contracts.js';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Flatten whatever input content is available for a batch into one text
 * blob, for the "did this batch's input contain anything claim-worthy" and
 * grounding checks. Accepts a plain string, or an array shaped like
 * `executor/index.js`'s `batch` parameter (`Array<{id?, content?}>` — the
 * items actually sent to the provider) or a task's full `items` array (same
 * shape). Multiple sources may be passed (this function is called with both
 * `batch` and `originalItems`); their text is concatenated rather than one
 * being required to be authoritative, since callers may have only one of the
 * two handy.
 *
 * @param {...(string|Array<string|{content?:string}>|null|undefined)} sources
 * @returns {string}
 */
function collectInputText(...sources) {
  const parts = [];
  for (const source of sources) {
    if (source == null) continue;
    if (typeof source === 'string') {
      parts.push(source);
      continue;
    }
    if (Array.isArray(source)) {
      for (const item of source) {
        if (item == null) continue;
        if (typeof item === 'string') parts.push(item);
        else if (typeof item.content === 'string') parts.push(item.content);
      }
    }
  }
  return parts.join('\n');
}

/** Matches this codebase's shared default `maxTokens` option — see
 * executor/index.js's `executeBatch()` (`maxTokens ?? 4096`) and every
 * provider adapter under executor/*.js (anthropic/openai/groq/cerebras/
 * gemini/openrouter all default the same call option to 4096 when a caller
 * does not override it). NOTE, per the task brief's own request to document
 * any deviation: `provider-profiles.js` was checked first and has NO
 * output-token-ceiling field — `contextWindow`/`tokensPerItem`/`maxBatchSize`
 * there are all INPUT-side batch-sizing figures, not an output cap — so this
 * constant instead mirrors the executor layer's real, verified default.
 * `scoreDeterministic()`'s `opts.maxTokensLimit` lets a caller override this
 * with the actual limit passed to that specific `executeBatch()` call, which
 * is always more accurate than this fallback. */
const DEFAULT_MAX_TOKENS_LIMIT = 4096;

/** Rough English-text chars-per-token estimate (OpenAI's own public rule of
 * thumb). This is a heuristic for "is the answer suspiciously close to the
 * ceiling", not a real tokenizer — it will be off for code, non-English
 * text, or dense numeric content. Documented as a heuristic, not a proof. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** An answer must be estimated at or above this fraction of the token
 * ceiling before "does not end in sentence-ending punctuation" is even
 * considered a truncation signal — otherwise a short answer that simply
 * doesn't end in punctuation (a list, a bare number) would be flagged. */
const TRUNCATION_PROXIMITY_THRESHOLD = 0.9;

/** Punctuation/closing characters that plausibly end a sentence. Deliberately
 * loose (a heuristic, not a grammar parser) — see `looksTruncated()`. */
const SENTENCE_END_RE = /[.!?"'”’)\]]\s*$/;

/**
 * Heuristic: does `answer` look like it was cut off by an output-length
 * ceiling? True only when BOTH signals agree: it does not end in
 * sentence-ending punctuation, AND its estimated token length is already
 * close to the ceiling. Neither signal alone is reliable (many valid answers
 * end in a number or a code fence; many long answers are simply verbose) —
 * this is a documented heuristic, not proof of truncation.
 */
function looksTruncated(answer, maxTokensLimit) {
  const text = String(answer ?? '').trim();
  if (text.length === 0) return false; // parseEnvelope() already requires a non-empty answer to reach here
  const endsCleanly = SENTENCE_END_RE.test(text);
  const estimatedTokens = text.length / CHARS_PER_TOKEN_ESTIMATE;
  const nearCeiling = estimatedTokens >= maxTokensLimit * TRUNCATION_PROXIMITY_THRESHOLD;
  return !endsCleanly && nearCeiling;
}

/* -------------------------------------------------------------------------- */
/* 1. The deterministic half                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Sub-check weights within `scoreDeterministic()`'s own [0,1] score. Sum to
 * 1.0. Exported (not inlined) so a later phase or a test can reference
 * exactly what this half of the metric is made of without guessing.
 *
 *   - claimsPresence (0.25): claims non-empty, OR legitimately empty because
 *     the batch's own input had nothing quantifiable in it.
 *   - noTruncation (0.15): the answer doesn't look cut off mid-output. Lower
 *     weight than the others because it is the least reliable of the four
 *     signals (see `looksTruncated()`'s own heuristic caveat).
 *   - claimsWellFormed (0.30): every claim's fields are non-degenerate.
 *     NOTE: in the normal `mergeRoute()` wiring this is close to redundant —
 *     `executor/envelope.js`'s `parseEnvelope()` already fail-closed rejects
 *     an envelope with a degenerate claim field, so anything reaching this
 *     function with `valid: true` has already passed the same checks. It is
 *     kept here anyway as defense-in-depth: `scoreDeterministic()` does not
 *     assume its caller always went through `parseEnvelope()` first (this
 *     module's own tests construct envelopes directly), so it re-validates
 *     rather than trusting an untraced input.
 *   - claimsGrounded (0.30): the real anti-hallucination check — the
 *     heaviest weight alongside well-formedness, since a model that invents
 *     a claim referencing nothing in its own input is the specific failure
 *     mode this half of the metric exists to catch.
 */
export const DETERMINISTIC_CHECK_WEIGHTS = Object.freeze({
  claimsPresence: 0.25,
  noTruncation: 0.15,
  claimsWellFormed: 0.3,
  claimsGrounded: 0.3
});

/**
 * Score one batch's envelope on deterministic, self-contained grounds only
 * (no knowledge of any other batch — that is `scoreConsistency()`'s job).
 *
 * @param {{valid:boolean, envelope:{answer:string, claims:object[]}|null, reason:string|null}} parseResult -
 *   the FULL return value of `executor/envelope.js`'s `parseEnvelope()`, not
 *   just the parsed envelope — so this function never re-derives validity,
 *   per the task brief: an invalid envelope scores 0 and stops immediately.
 * @param {Array<string|{content?:string}>|string|null} batch - the items
 *   actually sent to the provider for this batch (same shape as
 *   `executor/index.js`'s `batch` parameter). May be omitted if unavailable.
 * @param {Array<string|{content?:string}>|string|null} originalItems - the
 *   task's original item set, accepted as an alias/fallback for `batch` (a
 *   caller may only have one of the two handy); when both are given their
 *   text is concatenated, not one treated as authoritative over the other.
 * @param {{maxTokensLimit?:number}} [opts]
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreDeterministic(parseResult, batch, originalItems, opts = {}) {
  if (!parseResult || parseResult.valid !== true || !parseResult.envelope) {
    return { score: 0, reasons: ['envelope_invalid'] };
  }

  const { answer, claims: rawClaims } = parseResult.envelope;
  const claims = Array.isArray(rawClaims) ? rawClaims : [];
  const inputText = collectInputText(batch, originalItems);
  const inputProvided = inputText.trim().length > 0;
  const maxTokensLimit = Number.isFinite(opts.maxTokensLimit) ? opts.maxTokensLimit : DEFAULT_MAX_TOKENS_LIMIT;

  const w = DETERMINISTIC_CHECK_WEIGHTS;
  const reasons = [];
  let score = 0;

  // 1. Claims presence --------------------------------------------------------
  // An envelope with zero claims is only a free pass when the batch's OWN
  // input plausibly had nothing quantifiable in it. "Contains no digits at
  // all" is a deliberately simple proxy for "claim-worthy content" — it will
  // miss a batch whose only quantities are spelled out in words ("twelve
  // dispatches"), which is a documented limitation, not an oversight.
  let claimsPresenceScore;
  if (claims.length > 0) {
    claimsPresenceScore = 1;
    reasons.push('claims_present');
  } else if (!inputProvided) {
    // No input content was supplied to judge against at all -- cannot fault
    // the batch for something this function has no way to check.
    claimsPresenceScore = 1;
    reasons.push('zero_claims_no_input_content_to_judge_against');
  } else if (!/\d/.test(inputText)) {
    claimsPresenceScore = 1;
    reasons.push('zero_claims_expected_input_has_no_digits');
  } else {
    claimsPresenceScore = 0;
    reasons.push('zero_claims_but_input_contains_quantifiable_content');
  }
  score += w.claimsPresence * claimsPresenceScore;

  // 2. No truncation ------------------------------------------------------
  const truncated = looksTruncated(answer, maxTokensLimit);
  score += w.noTruncation * (truncated ? 0 : 1);
  reasons.push(truncated ? 'answer_looks_truncated_heuristic' : 'answer_not_truncated');

  // 3. Claims well-formed ---------------------------------------------------
  let wellFormedCount = 0;
  for (const claim of claims) {
    const valueOk = typeof claim?.value === 'number' && Number.isFinite(claim.value);
    const subjectOk = typeof claim?.subject === 'string' && claim.subject.trim().length > 0;
    const unitOk = typeof claim?.unit === 'string' && claim.unit.trim().length > 0;
    const confidenceOk =
      claim?.confidence === null ||
      claim?.confidence === undefined ||
      (typeof claim.confidence === 'number' && claim.confidence >= 0 && claim.confidence <= 1);
    if (valueOk && subjectOk && unitOk && confidenceOk) wellFormedCount += 1;
  }
  const wellFormedFraction = claims.length === 0 ? 1 : wellFormedCount / claims.length;
  score += w.claimsWellFormed * wellFormedFraction;
  reasons.push(`claims_well_formed:${wellFormedCount}/${claims.length}`);

  // 4. Claims grounded ------------------------------------------------------
  // Real anti-hallucination check. Deliberately simple and deterministic:
  // substring match on the claim's own `value`, OR at least one shared
  // stemmed content word between the claim's `subject` and the batch's
  // input text (bag-of-stems overlap, reusing align/text.js's primitives —
  // the same tokenizer merge/consistency.js already uses for subject
  // matching). REAL LIMITATION (see final report): this will miss a claim
  // that is genuinely grounded but paraphrased far from the source wording
  // (no semantic understanding here, just token overlap) -- and it can also
  // be fooled by a subject that happens to share a common word with the
  // input without actually describing the same fact. It is a real signal,
  // not a proof.
  let groundedFraction = 1;
  if (claims.length === 0) {
    reasons.push('grounding_check_vacuous_zero_claims');
  } else if (!inputProvided) {
    reasons.push('grounding_check_skipped_no_input_content_provided');
  } else {
    const inputStems = new Set(contentStems(tokenize(inputText)));
    let groundedCount = 0;
    for (const claim of claims) {
      const groundedByValue = typeof claim?.value !== 'undefined' && inputText.includes(String(claim.value));
      const subjectStems = contentStems(tokenize(String(claim?.subject ?? '')));
      const groundedBySubject = subjectStems.some((s) => inputStems.has(s));
      if (groundedByValue || groundedBySubject) groundedCount += 1;
    }
    groundedFraction = groundedCount / claims.length;
    reasons.push(`claims_grounded:${groundedCount}/${claims.length}`);
  }
  score += w.claimsGrounded * groundedFraction;

  return { score: Math.max(0, Math.min(1, score)), reasons };
}

/* -------------------------------------------------------------------------- */
/* 2. The consistency half                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Score one batch on cross-batch consistency: what fraction of THIS batch's
 * claims survived `merge/consistency.js`'s `crossCheckBatches()` without
 * being on the losing/contradicting side.
 *
 * Formula, exactly: every claim belonging to (`provider`, `batchIndex`) is
 * classified once, by reference identity (a claim object may be compared
 * against several peers, but it is one claim, counted once):
 *   - CONTRADICTED if it appears as either side of at least one entry in
 *     `verification.contradictions` -- even if it ALSO appears in an
 *     agreement with a different peer. A claim that loses even one
 *     cross-check is treated as a loss rather than averaged away, erring
 *     toward caution -- consistent with this codebase's fail-closed stance
 *     elsewhere (`executor/envelope.js`'s `parseEnvelope()`).
 *   - Otherwise AGREED if it appears as either side of at least one entry in
 *     `verification.agreements`.
 *   - Otherwise NEUTRAL (it must be in `verification.unmatched` -- every
 *     claim `crossCheckBatches()` sees ends up in exactly one of "had >=1
 *     agree/contradict comparison" or "unmatched").
 *
 * Neutral claims carry NO PENALTY and NO CREDIT, per the task brief -- which
 * means they are excluded from BOTH the numerator and the denominator, not
 * counted as a soft positive or soft negative:
 *
 *   comparable = agreedCount + contradictedCount
 *   score = comparable === 0 ? 1 : agreedCount / comparable
 *
 * `comparable === 0` covers two cases: a batch that made zero claims at all,
 * and a batch whose claims were ALL unmatched (no peer data to compare
 * against). Both default to a neutral score of 1 -- there is no evidence
 * against the batch, and it would be unfair to score it as if it had failed
 * a check it never had the chance to take.
 *
 * @param {number} batchIndex
 * @param {string} provider
 * @param {{contradictions:object[], agreements:object[], unmatched:object[]}} verification -
 *   `merge/consistency.js`'s `crossCheckBatches()` return value for the
 *   WHOLE route (every batch), not pre-filtered to this one.
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreConsistency(batchIndex, provider, verification) {
  const belongsToBatch = (entry) => entry?.provider === provider && entry?.batchIndex === batchIndex;

  const contradicted = new Set();
  const agreed = new Set();
  const neutral = new Set();

  for (const c of verification?.contradictions ?? []) {
    if (belongsToBatch(c?.claimA)) contradicted.add(c.claimA.claim);
    if (belongsToBatch(c?.claimB)) contradicted.add(c.claimB.claim);
  }
  for (const a of verification?.agreements ?? []) {
    if (belongsToBatch(a?.claimA)) agreed.add(a.claimA.claim);
    if (belongsToBatch(a?.claimB)) agreed.add(a.claimB.claim);
  }
  for (const u of verification?.unmatched ?? []) {
    if (belongsToBatch(u)) neutral.add(u.claim);
  }

  // A claim that contradicts even one peer is a loss, even if it also
  // agreed with a different peer -- see the docstring above.
  for (const claim of contradicted) agreed.delete(claim);

  const comparable = agreed.size + contradicted.size;
  const score = comparable === 0 ? 1 : agreed.size / comparable;

  const reasons = [
    `consistency_tally: ${agreed.size} agreed, ${contradicted.size} contradicted, ${neutral.size} unmatched(neutral, excluded from ratio)`,
    comparable === 0 ? 'no_comparable_claims_neutral_default_score_1' : `score_is_agreed_over_comparable:${agreed.size}/${comparable}`
  ];

  return { score, reasons };
}

/* -------------------------------------------------------------------------- */
/* 3. Combined score                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Weights combining the two halves into one number. Consistency is weighted
 * higher than deterministic (0.65 vs 0.35): agreement across independent
 * providers is stronger evidence than a batch's own self-reported validity —
 * a batch can look perfectly well-formed and still be wrong, but two
 * independently-executed batches landing on the same fact is real external
 * corroboration. Named exported constants (not inlined) specifically so
 * Phase 4's learning loop can reference the exact weights used to produce
 * historical scores, rather than guessing them back out of recorded numbers.
 */
export const DETERMINISTIC_WEIGHT = 0.35;
export const CONSISTENCY_WEIGHT = 0.65;

/**
 * Combine the deterministic and consistency halves into one score for a
 * batch.
 *
 * @param {{valid:boolean, envelope:object|null, reason:string|null}} parseResult
 * @param {Array|string|null} batch
 * @param {Array|string|null} originalItems
 * @param {number} batchIndex
 * @param {string} provider
 * @param {{contradictions:object[], agreements:object[], unmatched:object[]}} verification
 * @param {{maxTokensLimit?:number}} [opts]
 * @returns {{
 *   combinedScore: number,
 *   deterministicScore: number,
 *   consistencyScore: number,
 *   weights: {deterministic:number, consistency:number},
 *   reasons: string[]
 * }}
 */
export function scoreBatch(parseResult, batch, originalItems, batchIndex, provider, verification, opts = {}) {
  const det = scoreDeterministic(parseResult, batch, originalItems, opts);
  const cons = scoreConsistency(batchIndex, provider, verification);
  const combinedScore = DETERMINISTIC_WEIGHT * det.score + CONSISTENCY_WEIGHT * cons.score;

  return {
    combinedScore,
    deterministicScore: det.score,
    consistencyScore: cons.score,
    weights: { deterministic: DETERMINISTIC_WEIGHT, consistency: CONSISTENCY_WEIGHT },
    reasons: [...det.reasons, ...cons.reasons]
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Recording to the ledger                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the `'batch-quality-scored'` ledger event for one batch's score.
 * THIS EXACT PAYLOAD SHAPE IS THE CONTRACT A LATER PHASE BUILDS ON: Phase 3's
 * measurement campaign and Phase 4's learned degradation curves read
 * `contextRatio` alongside `combinedScore` back out of the ledger to fit
 * quality-as-a-function-of-context-load curves, per provider. Do not rename
 * or restructure these payload fields without updating that later phase.
 *
 * `contextRatio` is NOT computed here — it comes from `route-contracts.js`'s
 * `estimateProviderFit()` (the caller already has this from route planning);
 * this function only threads it through into the recorded payload. Pass
 * `null` when genuinely unavailable rather than fabricating a number — a
 * later degradation-curve fit needs to be able to tell "unknown" apart from
 * "measured zero".
 *
 * `workloadType` (OPTIONAL — closes the gap `ledger/curves.js`'s file header
 * used to document as future work): when a caller supplies it (normally
 * `profiling/classify.js`'s `classifyWorkload(task).workloadType`, threaded
 * in by `merge/index.js`'s `mergeRoute()`), it is added to `payload` so
 * `ledger/curves.js`'s `fitDegradationCurve()` can fit a curve scoped to one
 * workload type, not just per-provider. ADDITIVE, NOT REQUIRED: when omitted
 * or nullish, the returned payload has NO `workloadType` key at all — the
 * object is byte-for-byte identical to this function's pre-existing shape,
 * so every caller that does not know about workload types (and every event
 * already on disk from before this field existed) keeps working unchanged.
 * `fitDegradationCurve()` treats such an event as "workload unknown" and
 * folds it into its provider-wide fallback pool rather than any specific
 * workload bucket — see that function's own docstring.
 *
 * @param {{taskId?:string, provider?:string, routeId?:string|null, batchIndex:number, contextRatio:number|null, scoreResult: ReturnType<typeof scoreBatch>, workloadType?:string|null}} args
 * @returns {object} a `createLedgerEvent()`-shaped event, ready for
 *   `ledger/store.js`'s `appendEvent()` — not appended here (this module
 *   does no I/O, matching `merge/index.js`'s existing build-then-caller-
 *   appends convention for `buildMergeLedgerEvent()`).
 */
export function buildQualityScoreEvent({ taskId, provider, routeId, batchIndex, contextRatio, scoreResult, workloadType }) {
  return createLedgerEvent({
    eventType: 'batch-quality-scored',
    taskId,
    provider,
    routeId,
    payload: {
      batchIndex,
      contextRatio: Number.isFinite(contextRatio) ? contextRatio : null, // the x-axis for degradation curves later
      deterministicScore: scoreResult.deterministicScore,
      consistencyScore: scoreResult.consistencyScore,
      combinedScore: scoreResult.combinedScore,
      weights: scoreResult.weights,
      reasons: scoreResult.reasons,
      // Additive: present only when a caller actually supplied one. See
      // this function's own docstring for why this must not default to
      // `null` (that would still change the payload's key set for every
      // pre-existing caller).
      ...(workloadType != null ? { workloadType } : {})
    }
  });
}
