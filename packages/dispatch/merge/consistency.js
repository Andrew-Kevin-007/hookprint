/**
 * QUORUM dispatch — merge/consistency.js
 *
 * The peer comparison engine: given claims from two or more DIFFERENT
 * batches (potentially different providers), decide whether they agree or
 * contradict on a shared fact. There is no authoritative side here — unlike
 * `packages/align` (frozen origin-vs-candidate asymmetry, a hard dimension
 * veto blocking e.g. "5%" from ever comparing to "2 of 37"), this is N
 * providers as PEERS, so this module normalises across dimensions instead of
 * vetoing across them. `packages/align` is read for reference only and
 * never imported from here — see the plan §"The pivotal decision".
 *
 * The one thing genuinely reused from `packages/align` is `text.js`'s
 * tokenising/stemming primitives (`tokenize`, `contentStems`, `dice`,
 * `stem`) — pure text utilities with no coupling to align's frozen claim
 * contract, imported directly rather than re-implemented, consistent with
 * this project's zero-dependency, no-embeddings ethos.
 */

import { tokenize, contentStems, dice, stem } from '../../align/text.js';

/* -------------------------------------------------------------------------- */
/* Subject matching                                                          */
/* -------------------------------------------------------------------------- */

/** Sørensen–Dice score at or above this, over stemmed content-word overlap, counts as "the same fact". */
const DEFAULT_SUBJECT_MATCH_THRESHOLD = 0.3;

/**
 * Are these two claims plausibly about the same underlying fact? A
 * lightweight, deterministic, no-embeddings token-overlap check — the
 * `subject` strings are tokenised and stemmed with `packages/align/text.js`
 * (the same utilities the document-checker uses), stopwords dropped, then
 * compared with the Dice coefficient.
 *
 * KNOWN SIMPLIFICATION (see final report): this is bag-of-stems overlap, not
 * anything resembling entity/relation matching. It will correctly match
 * close paraphrases ("dispatch records with a confidence value" vs
 * "dispatch records carrying a confidence value") and correctly reject
 * unrelated subjects, but it has no notion of negation, of a modifier that
 * flips the meaning ("records that failed" vs "records that passed" share
 * every content stem except one), or of two distinct entities that happen to
 * share vocabulary. A future pass should harden this.
 *
 * @param {{subject:string}} claimA
 * @param {{subject:string}} claimB
 * @param {{threshold?:number}} [opts]
 * @returns {boolean}
 */
export function subjectsMatch(claimA, claimB, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_SUBJECT_MATCH_THRESHOLD;
  const stemsA = contentStems(tokenize(String(claimA?.subject ?? '')));
  const stemsB = contentStems(tokenize(String(claimB?.subject ?? '')));
  return dice(stemsA, stemsB) >= threshold;
}

/* -------------------------------------------------------------------------- */
/* Dimension normalisation                                                    */
/* -------------------------------------------------------------------------- */

/** Unit strings treated as "this value is a percentage". */
const PERCENT_UNITS = new Set(['%', 'percent', 'percentage', 'pct']);
/** Unit strings treated as "this value is already a 0-1 fraction". */
const RATIO_UNITS = new Set(['ratio', 'fraction', 'proportion', 'rate']);

/**
 * Normalise one claim to a canonical `{ value, dimension }` pair so claims
 * expressed in different but compatible forms become comparable. This is
 * the specific capability `packages/align`'s hard dimension veto refuses:
 * "5%" (percent) and "2 of 37" (a numerator/denominator pair) both become a
 * ratio in [0, 1] here, rather than being vetoed apart because their surface
 * unit strings differ.
 *
 * Precedence, most concrete first:
 *   1. An explicit `denominator` (a "N of M" claim) — the most concrete
 *      ratio representation available, used even if `unit` also happens to
 *      say "percent" or similar.
 *   2. A percent-shaped `unit` — divided by 100.
 *   3. A ratio-shaped `unit` ('ratio'/'fraction'/'proportion'/'rate') — the
 *      value is assumed to already be expressed as a 0-1 fraction.
 *   4. Anything else: an absolute magnitude. Its dimension is keyed by the
 *      STEMMED unit string ("records"/"dispatches" both stem toward a
 *      shared form) rather than a fixed currency/duration conversion table
 *      — deliberately simpler than align/quantity.js, since this module's
 *      job is peer comparison, not the document-provenance story align
 *      already owns. Two absolute claims only compare when their stemmed
 *      unit families match.
 *
 * @param {{value:number, unit:string, denominator?:number|null}} claim
 * @returns {{ value: number, dimension: string }}
 */
export function normalizeClaim(claim) {
  const unit = String(claim?.unit ?? '').trim().toLowerCase();
  const hasDenominator = Number.isFinite(claim?.denominator) && claim.denominator !== 0;

  if (hasDenominator) {
    return { value: claim.value / claim.denominator, dimension: 'ratio' };
  }
  if (PERCENT_UNITS.has(unit)) {
    return { value: claim.value / 100, dimension: 'ratio' };
  }
  if (RATIO_UNITS.has(unit)) {
    return { value: claim.value, dimension: 'ratio' };
  }

  const family = unit ? stem(unit) : 'unitless';
  return { value: claim.value, dimension: `absolute:${family}` };
}

/* -------------------------------------------------------------------------- */
/* Pairwise comparison                                                       */
/* -------------------------------------------------------------------------- */

/** Relative-difference tolerance for two normalised ratios: how far apart, as a fraction of the larger magnitude, before it's a real disagreement rather than rounding/measurement noise. 15% is a deliberately loose peer-vs-peer bar — this is two independent providers' own estimates, not an origin restatement being held to align's tighter honesty bar. */
const RATIO_TOLERANCE = 0.15;
/** Same idea, for two absolute claims that share a unit family. */
const ABSOLUTE_TOLERANCE = 0.15;

function relativeDelta(a, b) {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return 0;
  return Math.abs(a - b) / scale;
}

/**
 * Compare two claims. No authoritative side — this never decides which one
 * is "right", only whether they agree, contradict, or have nothing to do
 * with each other.
 *
 * @param {object} claimA
 * @param {object} claimB
 * @returns {{ relation: 'agree'|'contradict'|'unrelated', reason: string, delta: number|null }}
 */
export function compareClaims(claimA, claimB) {
  if (!subjectsMatch(claimA, claimB)) {
    return {
      relation: 'unrelated',
      reason: `subjects "${claimA?.subject}" and "${claimB?.subject}" do not overlap enough to be treated as the same fact`,
      delta: null
    };
  }

  const normA = normalizeClaim(claimA);
  const normB = normalizeClaim(claimB);

  if (normA.dimension !== normB.dimension) {
    return {
      relation: 'unrelated',
      reason: `subjects match but the values are not on a comparable dimension ("${normA.dimension}" vs "${normB.dimension}")`,
      delta: null
    };
  }

  const delta = relativeDelta(normA.value, normB.value);
  const tolerance = normA.dimension === 'ratio' ? RATIO_TOLERANCE : ABSOLUTE_TOLERANCE;

  if (delta <= tolerance) {
    return {
      relation: 'agree',
      reason: `normalized values ${normA.value.toFixed(4)} and ${normB.value.toFixed(4)} (dimension "${normA.dimension}") agree within the ${(tolerance * 100).toFixed(0)}% relative tolerance (actual difference ${(delta * 100).toFixed(1)}%)`,
      delta: null
    };
  }

  return {
    relation: 'contradict',
    reason: `normalized values ${normA.value.toFixed(4)} and ${normB.value.toFixed(4)} (dimension "${normA.dimension}") disagree by ${(delta * 100).toFixed(1)}%, beyond the ${(tolerance * 100).toFixed(0)}% tolerance`,
    delta
  };
}

/* -------------------------------------------------------------------------- */
/* Cross-batch check                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cross-check every claim in every batch against every claim from every
 * OTHER (provider, batchIndex) source — this is peer comparison, so claims
 * within the same batch are never compared against each other (there is no
 * second peer there to check against).
 *
 * @param {Array<{provider:string, batchIndex:number, envelope:{claims:object[]}}>} batchResults
 * @returns {{
 *   contradictions: Array<{claimA:object, claimB:object, comparison:object}>,
 *   agreements: Array<{claimA:object, claimB:object, comparison:object}>,
 *   unmatched: Array<{provider:string, batchIndex:number, claim:object}>
 * }}
 */
export function crossCheckBatches(batchResults) {
  const results = Array.isArray(batchResults) ? batchResults : [];

  const flat = [];
  for (const result of results) {
    const claims = Array.isArray(result?.envelope?.claims) ? result.envelope.claims : [];
    for (const claim of claims) {
      flat.push({ provider: result?.provider ?? null, batchIndex: result?.batchIndex ?? null, claim });
    }
  }

  const contradictions = [];
  const agreements = [];
  const matched = new Set();

  for (let i = 0; i < flat.length; i += 1) {
    for (let j = i + 1; j < flat.length; j += 1) {
      const a = flat[i];
      const b = flat[j];
      // Peer comparison: only compare claims from DIFFERENT sources.
      if (a.provider === b.provider && a.batchIndex === b.batchIndex) continue;

      const comparison = compareClaims(a.claim, b.claim);
      if (comparison.relation === 'unrelated') continue;

      matched.add(i);
      matched.add(j);

      const entry = {
        claimA: { provider: a.provider, batchIndex: a.batchIndex, claim: a.claim },
        claimB: { provider: b.provider, batchIndex: b.batchIndex, claim: b.claim },
        comparison
      };

      if (comparison.relation === 'contradict') contradictions.push(entry);
      else agreements.push(entry);
    }
  }

  const unmatched = flat
    .map((entry, index) => ({ entry, index }))
    .filter(({ index }) => !matched.has(index))
    .map(({ entry }) => ({ provider: entry.provider, batchIndex: entry.batchIndex, claim: entry.claim }));

  return { contradictions, agreements, unmatched };
}
