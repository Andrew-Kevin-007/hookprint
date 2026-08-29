/**
 * index.js — the write gate. Wraps alignment + diff into a per-claim
 * ACCEPT/REJECT verdict.
 *
 * Owns: the pipeline wiring. Depends on: align, contract (and, at
 * integration time, diff — injected, see below).
 * Its module graph must contain zero network imports (verification test #17).
 *
 * ---------------------------------------------------------------------------
 * DEFAULT-DENY. Read this before calling gate().
 * ---------------------------------------------------------------------------
 *
 * A claim is PROPOSED (a Candidate, downstream). gate() evaluates it and
 * returns ACCEPT or REJECT. Only an ACCEPTed claim is canonical; a REJECTed
 * one leaves canonical state explicitly unchanged, never silently. This
 * mechanises CONTENT-BRIEF.md §0.2's stated invariant: "verification failure
 * cannot silently become acceptance."
 *
 * Two places in this file are where that invariant would leak if written
 * carelessly, and both are handled the same way — refuse rather than guess:
 *
 * 1. opts.diffFn defaults to the real diffClaim (diff.js merged in below) —
 *    never to a no-op. A no-op differ that returns [] would make every
 *    aligned claim ACCEPT (no deltas => no fail severity => ACCEPT) —
 *    silently. That is precisely the failure mode this module exists to
 *    prevent. opts.diffFn stays overridable so tests can inject a mock
 *    differ without depending on diff.js's real behaviour.
 *
 * 2. An `ambiguous` alignment never reaches diffFn. contract.js's makeReport
 *    already refuses to accept a Delta built from an ambiguous alignment
 *    (decision 3) — this function honours the same rule one level up, before
 *    a Delta is ever constructed, and turns it into an explicit REJECT
 *    verdict rather than a silently-absent one.
 */

import { makeReport } from './contract.js';
import { align } from './align.js';
import { diffClaim } from './diff.js';

/**
 * Evaluate one hop's candidates against a set of origin claims and return a
 * verdict for every claim that reached an alignment, plus the underlying
 * Report.
 *
 * @param {Array} claims      contract.js Claims (origins).
 * @param {Array} candidates  contract.js Candidates, all from the SAME hop.
 * @param {number} hop        the hop being checked (>= 1). Every candidate
 *                             must carry this same hop — see the check below.
 *                             Passed through to opts.diffFn because a Delta
 *                             needs to know which hop the corruption
 *                             appeared at, and align()'s output alone does
 *                             not carry it for an ambiguous row.
 * @param {object} [opts]
 * @param {(claim, candidate, hop) => Array} opts.diffFn
 *        Required. Returns an array of contract.js Delta objects (build them
 *        with makeDelta) for one aligned (claim, candidate) pair. Injected so
 *        this module is testable without diff.js existing yet — see the file
 *        header.
 *
 * @returns {{report: object, verdicts: Array}}
 *   report   — the contract.js Report: alignments, deltas, unaligned,
 *              dropped_claims. unaligned/dropped_claims are the honesty
 *              receipt (nobody guessed) and are NOT verdicts on a proposal —
 *              they stay out of the verdicts array on purpose (see below).
 *   verdicts — one entry per Alignment (matched or ambiguous), each
 *              {claimId, cid, status: 'ACCEPT'|'REJECT', reason, canonical,
 *              deltas}.
 */
export function gate(claims, candidates, hop, opts = {}) {
  if (!Array.isArray(claims)) throw new Error('gate: claims must be an array of contract.js Claims');
  if (!Array.isArray(candidates)) throw new Error('gate: candidates must be an array of contract.js Candidates');
  if (!Number.isInteger(hop) || hop < 1) throw new Error('gate: hop must be an integer >= 1');

  const diffFn = opts.diffFn ?? diffClaim;
  if (typeof diffFn !== 'function') {
    throw new Error(
      'gate: opts.diffFn, when passed, must be a function — got ' + typeof opts.diffFn
    );
  }

  for (const c of candidates) {
    if (c.hop !== hop) {
      throw new Error(
        `gate: candidate ${c.cid} carries hop ${c.hop} but gate() was called with hop ${hop} — ` +
          'all candidates passed to one gate() call must be from the same hop'
      );
    }
  }

  const { alignments, unaligned, dropped_claims } = align(claims, candidates);

  const deltas = [];
  const verdicts = [];

  for (const a of alignments) {
    if (a.decision === 'ambiguous') {
      // No diff is possible on an ambiguous alignment — contract.js already
      // refuses a Delta here (decision 3). The verdict must still be
      // explicit, not silently absent: default-deny.
      verdicts.push({
        claimId: a.claimId,
        cid: a.cid,
        status: 'REJECT',
        reason: 'ambiguous_alignment',
        canonical: 'unchanged',
        deltas: []
      });
      continue;
    }

    const claim = findClaim(claims, a.claimId);
    const candidate = findCandidate(candidates, a.cid);

    const claimDeltas = diffFn(claim, candidate, hop);
    if (!Array.isArray(claimDeltas)) {
      throw new Error(`gate: opts.diffFn must return an array of Delta, got ${typeof claimDeltas}`);
    }
    deltas.push(...claimDeltas);

    const failDelta = claimDeltas.find((d) => d.severity === 'fail');
    verdicts.push({
      claimId: a.claimId,
      cid: a.cid,
      status: failDelta ? 'REJECT' : 'ACCEPT',
      reason: failDelta ? failDelta.class : null,
      canonical: failDelta ? 'unchanged' : 'updated',
      deltas: claimDeltas
    });
  }

  // unaligned candidates and dropped claims are NOT verdicts on a proposal —
  // they are the honesty receipt (nobody guessed). Kept separate from
  // verdicts in the returned shape: "we refused to guess" and "we rejected a
  // proposal" are different findings, and conflating them would be a real
  // bug, not a UX nit (BUILD-PLAN.md's own framing).
  const report = makeReport({ alignments, deltas, unaligned, dropped_claims });
  return { report, verdicts };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Both throw rather than return null/undefined on a miss. align() only ever
 * emits an Alignment whose claimId/cid come from the arrays it was handed, so
 * a miss here means align()'s own invariant broke — a bug to surface loudly,
 * not a normal input case to degrade gracefully around (contract.js's own
 * `fail()` discipline, applied here).
 */
function findClaim(claims, claimId) {
  const c = claims.find((x) => x.id === claimId);
  if (!c) throw new Error(`gate: alignment referenced claim ${claimId}, which is not in the supplied claims — align() invariant violated`);
  return c;
}

function findCandidate(candidates, cid) {
  const c = candidates.find((x) => x.cid === cid);
  if (!c) throw new Error(`gate: alignment referenced candidate ${cid}, which is not in the supplied candidates — align() invariant violated`);
  return c;
}

/**
 * ---------------------------------------------------------------------------
 * WIRING NOTE — how diff.js's real diffClaim plugs in once that stream lands.
 * ---------------------------------------------------------------------------
 *
 * diff.js's documented shape (see its own header, and README.md's module
 * table) is `diffClaim(claim, candidate) -> Delta[]`, taking a Claim and a
 * Candidate that are already known to be aligned — exactly the two objects
 * this file resolves via findClaim/findCandidate before calling opts.diffFn.
 * diff.js does not need `hop` to do its own comparison work (a Delta's `hop`
 * field is the hop the corruption appeared at, which is `candidate.hop` /
 * the alignment's `hop` — diff.js can read it off either argument), but
 * gate() passes `hop` through as a third argument regardless, both because
 * the pseudocode contract for opts.diffFn is 3-ary and because it costs
 * nothing to hand over a value the callee may already be able to derive.
 * A thin adapter closes the gap if the real signature turns out to be
 * strictly 2-ary:
 *
 *   import { diffClaim } from './diff.js';
 *   const { report, verdicts } = gate(claims, candidates, hop, {
 *     diffFn: (claim, candidate, _hop) => diffClaim(claim, candidate)
 *   });
 *
 * No other change to this file is needed. The one thing integration must
 * verify (not assumed here): that diff.js's Deltas were built with
 * `makeDelta` from contract.js, so `severity`/`class` are the frozen
 * enum values `failDelta.severity === 'fail'` above compares against — a
 * hand-shaped object that merely looks like a Delta would silently never
 * trip the REJECT branch. `makeReport` re-validates every delta's shape
 * regardless, so a malformed Delta from a buggy diffClaim throws at the
 * `makeReport` call above rather than passing through unnoticed.
 */
