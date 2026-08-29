/**
 * align.js — turn the score matrix into a matching: matched / ambiguous
 * decisions, the monotonic-order constraint (fallback B), and an `unaligned`
 * receipt with a frozen reason for every candidate that does not match.
 *
 * Owns: matrix -> Alignment[] + unaligned[]. Depends on: score, contract.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THIS FILE IS RESPONSIBLE FOR NOT DOING.
 *
 * 1. NOT GUESSING. When the best claim for a candidate beats the runner-up by
 *    less than MARGIN, the honest output is `decision: 'ambiguous'`, and
 *    contract.js then forbids diff.js from emitting any Delta from that row. A
 *    wrong match producing a confident `value_drift` on stage is far worse than
 *    an ambiguous row a judge can read (contract.js decision 3).
 *
 * 2. NOT FABRICATING A MATCH TO FILL THE TABLE. Every candidate leaves this
 *    function exactly once: as an Alignment, as a supporting fragment of one,
 *    or in `unaligned` with a reason from the frozen list. Every claim likewise
 *    ends up matched or in `dropped_claims`. The receipt is the product
 *    (contract.js decision 4).
 *
 * 3. NOT DEPENDING ON INPUT ORDER. Both sides are sorted into canonical id
 *    order before anything is scored, so the index-based tie-breaks below are
 *    the same tie-breaks whatever order the caller iterated its files in.
 *    Shuffling the candidate array must produce a byte-identical report —
 *    verification test #16, and the reason the pitch can say "run it with the
 *    network off" and mean something.
 */

import {
  makeAlignment, makeUnaligned, makeDroppedClaim, compareAlignments
} from './contract.js';
import { buildIdf, scorePair, ACCEPT, MARGIN, SUPPORT } from './score.js';

/**
 * Align a set of downstream candidates to a set of origin claims.
 *
 * @param {Array} claims      contract.js Claims (origins).
 * @param {Array} candidates  contract.js Candidates (one downstream hop).
 * @returns {{alignments: Array, unaligned: Array, dropped_claims: Array}}
 *          The three arrays report.js hands to makeReport.
 */
export function align(claims, candidates) {
  const C = canonical(claims, (x) => x.id);
  const D = canonical(candidates, (x) => x.cid);

  const claimViews = C.map((c, i) => view(c, i, C.length));
  const candViews = D.map((d, i) => view(d, i, D.length));

  const idf = buildIdf(claimViews);

  // The full matrix. Kept whole rather than streamed: the supporting pass and
  // the runner-up margin both need to look at scores the greedy walk skipped.
  const matrix = claimViews.map((cv) => candViews.map((dv) => scorePair(cv, dv, idf)));

  const pairs = [];
  for (let i = 0; i < C.length; i += 1) {
    for (let j = 0; j < D.length; j += 1) {
      pairs.push({ i, j, score: matrix[i][j].score });
    }
  }
  // Score descending; ties broken by canonical claim index then candidate
  // index, which is canonical id order — so this ordering is a property of the
  // data, not of how the caller happened to build its arrays.
  pairs.sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);

  const claimUsed = new Array(C.length).fill(false);
  const candUsed = new Array(D.length).fill(false);
  const alignments = [];
  const alignmentByClaim = new Map();
  const ambiguousClaims = new Set();

  for (const p of pairs) {
    if (p.score < ACCEPT) break; // sorted, so nothing below the floor remains
    if (claimUsed[p.i] || candUsed[p.j]) continue;

    const runner = bestOtherClaim(matrix, p.i, p.j, claimUsed);
    const margin = round12(p.score - (runner ? runner.score : 0));
    const cell = matrix[p.i][p.j];

    // Too close to call between two claims. Take the candidate off the table —
    // it has had its answer — but leave the claim available, because we have
    // not actually assigned it to anything.
    if (runner && p.score - runner.score < MARGIN) {
      const a = makeAlignment({
        claimId: C[p.i].id,
        cid: D[p.j].cid,
        hop: D[p.j].hop,
        score: p.score,
        margin,
        channels: { NUM: cell.NUM, LEX: cell.LEX, POS: cell.POS },
        decision: 'ambiguous',
        runnerUp: { claimId: C[runner.i].id, score: runner.score },
        supporting: []
      });
      alignments.push(a);
      candUsed[p.j] = true;
      ambiguousClaims.add(p.i);
      continue;
    }

    const a = makeAlignment({
      claimId: C[p.i].id,
      cid: D[p.j].cid,
      hop: D[p.j].hop,
      score: p.score,
      margin,
      channels: { NUM: cell.NUM, LEX: cell.LEX, POS: cell.POS },
      decision: 'matched',
      runnerUp: runner ? { claimId: C[runner.i].id, score: runner.score } : null,
      supporting: []
    });
    alignments.push(a);
    alignmentByClaim.set(p.i, a);
    claimUsed[p.i] = true;
    candUsed[p.j] = true;
  }

  // SUPPORTING PASS. A claim split across two sentences ("2 of 252 dispatches"
  // becoming "252 dispatches were sent. 2 carried a confidence value.") leaves
  // a strong second fragment with nowhere to go. Attaching it here is what lets
  // diff.js later recover a denominator that moved sentences rather than
  // reporting it as lost — the difference between a finding and a false alarm.
  const supportingOf = new Set();
  for (let j = 0; j < D.length; j += 1) {
    if (candUsed[j]) continue;
    const best = bestClaimFor(matrix, j);
    if (!best || best.score < SUPPORT) continue;
    const owner = alignmentByClaim.get(best.i);
    if (!owner) continue; // its best claim is unmatched: not a fragment, a miss
    owner.supporting.push(D[j].cid);
    supportingOf.add(j);
  }
  for (const a of alignments) a.supporting.sort();

  // RECEIPTS. Every candidate that did not become an alignment or a supporting
  // fragment leaves with a reason from the frozen list.
  const unaligned = [];
  for (let j = 0; j < D.length; j += 1) {
    if (candUsed[j] || supportingOf.has(j)) continue;
    const best = bestClaimFor(matrix, j);
    if (!D[j].quantity) {
      unaligned.push(makeUnaligned(D[j].cid, 'no_quantity',
        'no parseable quantity, so there is nothing to check'));
    } else if (!best || best.score < ACCEPT) {
      unaligned.push(makeUnaligned(D[j].cid, 'below_floor',
        `best score ${best ? round12(best.score) : 0} is under the accept threshold ${ACCEPT}`));
    } else {
      unaligned.push(makeUnaligned(D[j].cid, 'claim_exhausted',
        `its best claim ${C[best.i].id} is already held by a stronger candidate`));
    }
  }

  const dropped = [];
  for (let i = 0; i < C.length; i += 1) {
    if (claimUsed[i]) continue;
    if (D.length === 0) {
      dropped.push(makeDroppedClaim(C[i].id, 'hop_absent', 'the downstream document has no candidates'));
      continue;
    }
    const best = bestCandidateFor(matrix, i);
    if (ambiguousClaims.has(i) && best && best.score >= ACCEPT) {
      dropped.push(makeDroppedClaim(C[i].id, 'ambiguous_only',
        'every candidate above the floor was too close to another claim to call'));
    } else {
      dropped.push(makeDroppedClaim(C[i].id, 'no_candidate',
        `best candidate scored ${best ? round12(best.score) : 0}, under the accept threshold ${ACCEPT}`));
    }
  }

  return {
    alignments: alignments.sort(compareAlignments),
    unaligned,
    dropped_claims: dropped
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Sort into canonical id order. This is what makes the whole function
 * order-independent: after this line, nothing downstream can observe the order
 * the caller supplied. Falls back to the sentence text when an object carries
 * no id, so a bare-string caller is deterministic too.
 */
function canonical(xs, idOf) {
  return [...xs].sort((a, b) => {
    const ka = String(idOf(a) ?? a.text ?? '');
    const kb = String(idOf(b) ?? b.text ?? '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * The scoreable view of a claim or candidate, with its normalised position.
 *
 * A fresh object per run, so score.js's profile cache is populated once and
 * reused across the whole matrix rather than re-tokenising |claims|x|candidates|
 * times — and so we never mutate a caller's Claim to carry our own field.
 */
function view(x, i, n) {
  return {
    text: x.text,
    span: x.span ?? (x.evidence ? x.evidence.span : undefined),
    quantity: x.quantity ?? null,
    unit: x.unit ?? null,
    ordinal: Number.isInteger(x.ordinal) ? x.ordinal : i,
    normOrdinal: n <= 1 ? 0 : i / (n - 1)
  };
}

/** The best score for candidate `j` over every claim. */
function bestClaimFor(matrix, j) {
  let best = null;
  for (let i = 0; i < matrix.length; i += 1) {
    const s = matrix[i][j].score;
    if (best === null || s > best.score) best = { i, score: s };
  }
  return best;
}

/** The best score for claim `i` over every candidate. */
function bestCandidateFor(matrix, i) {
  let best = null;
  for (let j = 0; j < matrix[i].length; j += 1) {
    const s = matrix[i][j].score;
    if (best === null || s > best.score) best = { j, score: s };
  }
  return best;
}

/**
 * The strongest OTHER claim still available for candidate `j`.
 *
 * Only live claims count. A claim already held by a stronger candidate is not a
 * plausible alternative reading of this one, so counting it would manufacture
 * ambiguity that is not there and suppress a delta we should have reported.
 */
function bestOtherClaim(matrix, i, j, claimUsed) {
  let best = null;
  for (let k = 0; k < matrix.length; k += 1) {
    if (k === i || claimUsed[k]) continue;
    const s = matrix[k][j].score;
    if (best === null || s > best.score) best = { i: k, score: s };
  }
  return best;
}

function round12(x) {
  return Number.isFinite(x) ? Number(x.toFixed(12)) : 0;
}
