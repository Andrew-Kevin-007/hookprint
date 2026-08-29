/**
 * transitions.js — explicit state transitions on top of packages/align's
 * gate(), per threat-model §4: agents should not hold a generic UPDATE
 * permission. gate() today treats every incoming Candidate as an implicit
 * "I believe this restates an existing claim" proposal. This module names
 * that intent explicitly (PROPOSE_UPDATE) and adds four more the doc
 * specifies (DERIVE, CORRECT, CHALLENGE, ATTEST) — so the type is never
 * implicit again, and gate() is never reached except through the
 * PROPOSE_UPDATE wrapper.
 *
 * This file does not reimplement alignment or diffing. It is a thin layer:
 *   - PROPOSE_UPDATE  -> calls the real gate() (align + diff), unchanged.
 *   - DERIVE          -> does NOT call gate()/diff() at all. A derived claim
 *                        is compared against whether its declared parents'
 *                        arithmetic checks out, not against a single origin
 *                        the way a restatement is (threat-model §14 — this
 *                        is exactly what keeps BATON from becoming "an
 *                        everything-must-look-identical validator").
 *   - CORRECT         -> diffs against the prior version (via diff.js, for
 *                        the audit trail) but never uses the diff to reject:
 *                        a correction is EXPECTED to differ from the claim
 *                        it corrects, and both versions are kept.
 *   - CHALLENGE       -> produces a third canonical state, CHALLENGED —
 *                        distinct from both ACCEPT and REJECT.
 *   - ATTEST          -> records a third-party vouch alongside the claim.
 *                        Never mutates the claim it attests to.
 *
 * Verdict vocabulary extends gate()'s {claimId, cid, status, reason,
 * canonical, deltas} rather than replacing it — every verdict below carries
 * that same base shape plus a `type` tag and whatever fields are specific to
 * that transition (challenger/reason for CHALLENGE, attester/statement for
 * ATTEST, parents/operation for DERIVE, priorClaimId for CORRECT).
 *
 * NOT built here (named, not hidden):
 *   - No identity/authorization layer. `challenger`, `attester`, `issuer`
 *     etc. are accepted as caller-supplied strings. Binding them to a
 *     verified signing key is packages/sign + equivocation.js/replay.js's
 *     job; this module does not itself check that a challenger is who they
 *     claim to be.
 *   - No multi-arbiter CHALLENGE resolution. A CHALLENGE here only records
 *     the dispute (status: CHALLENGED) — deciding who is right, and moving a
 *     claim back to ACCEPTed or permanently REJECTed, is a future, separate
 *     process (threat-model §33 Q17, "how are disputes settled").
 *   - No persistent transition log. Every function here is a pure
 *     transform over whatever `claims` array the caller passes in; nothing
 *     is written to durable storage. A real registry needs that; this
 *     hackathon build does not have one (see equivocation.js/replay.js for
 *     the same disclaimer on their in-memory stores).
 */

import { gate } from '../align/index.js';
import { diffClaim } from '../align/diff.js';

export const TRANSITION_TYPES = Object.freeze(['PROPOSE_UPDATE', 'DERIVE', 'CORRECT', 'CHALLENGE', 'ATTEST']);

/**
 * Supported DERIVE arithmetic operations. Deliberately a closed, explicit
 * list that the proposal must declare (see makeDerive below) rather than
 * something verifyDerivation infers by trying combinations until one fits —
 * inferring the operation would let an attacker's derived value be accepted
 * under WHICHEVER operation happens to reproduce it, rather than the one the
 * derivation actually claims to use.
 */
export const DERIVATION_OPERATIONS = Object.freeze(['ratio', 'sum', 'difference', 'product']);

function fail(where, msg) {
  throw new Error(`${where}: ${msg}`);
}
function isPlainObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}
function isNonEmptyString(x) {
  return typeof x === 'string' && x.length > 0;
}

/* -------------------------------------------------------------------------- */
/* makeProposal — throwing constructor, contract.js style                    */
/* -------------------------------------------------------------------------- */

/**
 * Wrap a Candidate (or, for CHALLENGE/ATTEST, just a target claim id) with an
 * explicit transition type. Throws on a malformed or incomplete proposal —
 * this is a shape check, not a security decision, so it fails loud rather
 * than returning something callers might not check.
 */
export function makeProposal(input) {
  const where = 'makeProposal';
  if (!isPlainObject(input)) fail(where, 'expected an object');
  if (!TRANSITION_TYPES.includes(input.type)) {
    fail(where, `type ${JSON.stringify(input.type)} is not one of ${TRANSITION_TYPES.join(', ')}`);
  }
  switch (input.type) {
    case 'PROPOSE_UPDATE':
      return makeProposeUpdate(input, where);
    case 'DERIVE':
      return makeDerive(input, where);
    case 'CORRECT':
      return makeCorrect(input, where);
    case 'CHALLENGE':
      return makeChallenge(input, where);
    case 'ATTEST':
      return makeAttest(input, where);
    /* c8 ignore next 2 -- unreachable: TRANSITION_TYPES.includes already refused any other value */
    default:
      return fail(where, `unhandled type ${input.type}`);
  }
}

function requireCandidate(input, where) {
  const { candidate } = input;
  if (!isPlainObject(candidate)) fail(where, 'candidate must be an object (a contract.js Candidate, or Candidate-shaped content)');
  if (!isNonEmptyString(candidate.cid)) fail(where, 'candidate.cid must be a non-empty string');
  if (!Number.isInteger(candidate.hop) || candidate.hop < 1) fail(where, 'candidate.hop must be an integer >= 1');
  return candidate;
}

function makeProposeUpdate(input, where) {
  const w = `${where}(PROPOSE_UPDATE)`;
  const candidate = requireCandidate(input, w);
  return Object.freeze({ type: 'PROPOSE_UPDATE', candidate });
}

function makeDerive(input, where) {
  const w = `${where}(DERIVE)`;
  const candidate = requireCandidate(input, w);
  const { parents, operation } = input;
  if (!Array.isArray(parents) || parents.length === 0) {
    fail(w, 'parents must be a non-empty array of claim ids — this is DERIVED_FROM');
  }
  for (const p of parents) {
    if (!isNonEmptyString(p)) fail(w, `every parent must be a non-empty claim id string, got ${JSON.stringify(p)}`);
  }
  if (!DERIVATION_OPERATIONS.includes(operation)) {
    fail(w, `operation ${JSON.stringify(operation)} is not one of ${DERIVATION_OPERATIONS.join(', ')} — the operation must be declared, not inferred`);
  }
  if ((operation === 'ratio' || operation === 'difference') && parents.length !== 2) {
    fail(w, `operation "${operation}" requires exactly 2 parents (order matters: parents[0] then parents[1]), got ${parents.length}`);
  }
  return Object.freeze({ type: 'DERIVE', candidate, parents: Object.freeze([...parents]), operation });
}

function makeCorrect(input, where) {
  const w = `${where}(CORRECT)`;
  const candidate = requireCandidate(input, w);
  const { targetClaimId, reason, newEvidence } = input;
  if (!isNonEmptyString(targetClaimId)) fail(w, 'targetClaimId must be a non-empty string — which claim this corrects');
  if (!isNonEmptyString(reason)) {
    fail(w, 'reason must be a non-empty string — a correction with no stated reason is indistinguishable from an unexplained overwrite');
  }
  const proposal = { type: 'CORRECT', candidate, targetClaimId, reason };
  if (newEvidence !== undefined) proposal.newEvidence = newEvidence;
  return Object.freeze(proposal);
}

function makeChallenge(input, where) {
  const w = `${where}(CHALLENGE)`;
  const { targetClaimId, targetCid, challenger, reason } = input;
  if (!isNonEmptyString(targetClaimId)) fail(w, 'targetClaimId must be a non-empty string');
  if (!isNonEmptyString(challenger)) fail(w, 'challenger must be a non-empty string — an anonymous challenge cannot be weighed or contested');
  if (!isNonEmptyString(reason)) fail(w, 'reason must be a non-empty string (free text is fine, but it must be present)');
  const proposal = { type: 'CHALLENGE', targetClaimId, challenger, reason };
  if (targetCid !== undefined && targetCid !== null) {
    if (!isNonEmptyString(targetCid)) fail(w, 'targetCid, when present, must be a non-empty string');
    proposal.targetCid = targetCid;
  }
  return Object.freeze(proposal);
}

function makeAttest(input, where) {
  const w = `${where}(ATTEST)`;
  const { targetClaimId, attester, statement, signature } = input;
  if (!isNonEmptyString(targetClaimId)) fail(w, 'targetClaimId must be a non-empty string');
  if (!isNonEmptyString(attester)) fail(w, "attester must be a non-empty string — a third party vouching anonymously vouches for nothing");
  const proposal = { type: 'ATTEST', targetClaimId, attester };
  if (statement !== undefined) {
    if (!isNonEmptyString(statement)) fail(w, 'statement, when present, must be a non-empty string');
    proposal.statement = statement;
  }
  if (signature !== undefined) {
    if (!isPlainObject(signature)) {
      fail(w, "signature, when present, must be an object {signature, publicKey, keyId?} — the ATTEST's own attestation, separate from the claim's original signature");
    }
    proposal.signature = signature;
  }
  return Object.freeze(proposal);
}

/* -------------------------------------------------------------------------- */
/* DERIVE                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Absolute tolerance for derivation arithmetic. Mirrors
 * packages/align/diff.js's arithmeticallyConsistent(), which uses the same
 * 0.01 absolute tolerance against fraction-scaled (0..1) quantity values
 * (dimension 'percent'/'ratio': value 0.1176 means "11.76%", NOT 11.76 — see
 * diff.js's own header for that convention). For 'sum'/'product' over
 * large-magnitude 'count' claims, an absolute tolerance is a blunter
 * instrument than a relative one — named here rather than silently assumed
 * to be fine at every scale.
 */
const DERIVATION_TOLERANCE = 0.01;

/**
 * verifyDerivation(proposal, parentClaims) -> { valid, reason?, expected?, actual?, missing? }
 *
 * A "check" function, not a constructor: never throws on a malformed or
 * garbage proposal/parentClaims, matching packages/sign's verifyBundle
 * discipline — an unexpected shape here fails the derivation closed
 * (valid: false) rather than crashing the caller.
 *
 * Two independent things must both hold, either failing rejects the whole
 * derivation:
 *   1. every id in proposal.parents actually resolves to a Claim in
 *      parentClaims (never trust a parent id nobody can find);
 *   2. proposal.candidate.quantity.value is arithmetically consistent with
 *      the parents' own quantity.value, combined via proposal.operation,
 *      within DERIVATION_TOLERANCE.
 *
 * This does NOT diff proposal.candidate against a single origin claim the
 * way PROPOSE_UPDATE's diffClaim does — see the file header. A derived claim
 * that correctly computes 2/17 = 11.76% must be ACCEPTed even though its
 * text and value textually match nothing upstream; that is the entire
 * reason DERIVE exists as a separate transition.
 */
export function verifyDerivation(proposal, parentClaims) {
  if (!isPlainObject(proposal) || proposal.type !== 'DERIVE') {
    return { valid: false, reason: 'not_a_derive_proposal' };
  }
  if (!Array.isArray(parentClaims)) {
    return { valid: false, reason: 'parent_claims_not_array' };
  }
  if (!Array.isArray(proposal.parents) || proposal.parents.length === 0) {
    return { valid: false, reason: 'no_declared_parents' };
  }

  const byId = new Map(parentClaims.filter(isPlainObject).map((c) => [c.id, c]));
  const resolved = [];
  const missing = [];
  for (const pid of proposal.parents) {
    const c = byId.get(pid);
    if (!c) missing.push(pid);
    else resolved.push(c);
  }
  if (missing.length > 0) {
    return { valid: false, reason: 'missing_parent', missing };
  }

  for (const c of resolved) {
    if (!isPlainObject(c.quantity) || typeof c.quantity.value !== 'number' || !Number.isFinite(c.quantity.value)) {
      return { valid: false, reason: 'parent_missing_quantity', claimId: c.id };
    }
  }

  const derivedQuantity = isPlainObject(proposal.candidate) ? proposal.candidate.quantity : null;
  if (!isPlainObject(derivedQuantity) || typeof derivedQuantity.value !== 'number' || !Number.isFinite(derivedQuantity.value)) {
    return { valid: false, reason: 'derived_missing_quantity' };
  }

  const values = resolved.map((c) => c.quantity.value);
  let expected;
  switch (proposal.operation) {
    case 'ratio':
      if (values.length !== 2) return { valid: false, reason: 'wrong_parent_count' };
      if (values[1] === 0) return { valid: false, reason: 'division_by_zero' };
      expected = values[0] / values[1];
      break;
    case 'difference':
      if (values.length !== 2) return { valid: false, reason: 'wrong_parent_count' };
      expected = values[0] - values[1];
      break;
    case 'sum':
      expected = values.reduce((a, b) => a + b, 0);
      break;
    case 'product':
      expected = values.reduce((a, b) => a * b, 1);
      break;
    default:
      return { valid: false, reason: 'unsupported_operation' };
  }

  const actual = derivedQuantity.value;
  if (Math.abs(actual - expected) > DERIVATION_TOLERANCE) {
    return { valid: false, reason: 'arithmetic_inconsistent', expected, actual };
  }
  return { valid: true, expected, actual };
}

/** Turn a verifyDerivation result into a verdict extending gate()'s shape. */
export function applyDerive(proposal, parentClaims) {
  const where = 'applyDerive';
  if (!isPlainObject(proposal) || proposal.type !== 'DERIVE') fail(where, 'proposal.type must be DERIVE (build it with makeProposal)');

  const result = verifyDerivation(proposal, parentClaims);
  const base = {
    type: 'DERIVE',
    claimId: null, // DERIVE proposes a NEW claim — it has no existing canonical id to attach to
    cid: proposal.candidate.cid,
    parents: [...proposal.parents],
    operation: proposal.operation,
    deltas: [] // never diffed against a single origin — see file header
  };

  if (!result.valid) {
    return { ...base, status: 'REJECT', reason: result.reason, canonical: 'unchanged', detail: result };
  }
  return {
    ...base,
    status: 'ACCEPT',
    reason: null,
    canonical: 'new_claim_recorded',
    detail: { expected: result.expected, actual: result.actual }
  };
}

/* -------------------------------------------------------------------------- */
/* PROPOSE_UPDATE — the only sanctioned path into gate()                     */
/* -------------------------------------------------------------------------- */

/**
 * applyProposeUpdate(proposal, claims, hop, opts) -> { report, verdicts }
 *
 * Requires proposal.type === 'PROPOSE_UPDATE' — gate() (packages/align) is
 * never reached from a bare Candidate through this module. Every verdict
 * gate() returns is passed through unchanged, tagged with `type`.
 */
export function applyProposeUpdate(proposal, claims, hop, opts = {}) {
  const where = 'applyProposeUpdate';
  if (!isPlainObject(proposal) || proposal.type !== 'PROPOSE_UPDATE') {
    fail(where, "proposal.type must be PROPOSE_UPDATE — gate() is never called from a bare Candidate (threat-model §4)");
  }
  const { report, verdicts } = gate(claims, [proposal.candidate], hop, opts);
  return { report, verdicts: verdicts.map((v) => ({ type: 'PROPOSE_UPDATE', ...v })) };
}

/* -------------------------------------------------------------------------- */
/* CORRECT                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * applyCorrect(proposal, claims, hop, opts) -> a single verdict.
 *
 * Diffs the new candidate against the prior claim with the real diffClaim
 * (default-deny discipline mirrored from gate(): opts.diffFn defaults to the
 * real differ, never a silent no-op) purely for the audit trail — the
 * resulting deltas are attached to the verdict but NEVER used to reject.
 * status is always CORRECTED when the target exists; the prior version is
 * never erased (this function does not delete anything — it is stateless
 * and returns pointers to both versions for the caller's history/log).
 */
export function applyCorrect(proposal, claims, hop, opts = {}) {
  const where = 'applyCorrect';
  if (!isPlainObject(proposal) || proposal.type !== 'CORRECT') fail(where, 'proposal.type must be CORRECT (build it with makeProposal)');
  if (!Array.isArray(claims)) fail(where, 'claims must be an array of contract.js Claims');

  const target = claims.find((c) => c.id === proposal.targetClaimId);
  if (!target) {
    return {
      type: 'CORRECT',
      claimId: proposal.targetClaimId,
      cid: proposal.candidate.cid,
      status: 'INVALID',
      reason: 'target_claim_not_found',
      canonical: 'unchanged',
      deltas: []
    };
  }

  const diffFn = opts.diffFn ?? diffClaim;
  if (typeof diffFn !== 'function') fail(where, `opts.diffFn, when passed, must be a function — got ${typeof opts.diffFn}`);
  const deltas = diffFn(target, proposal.candidate, hop);
  if (!Array.isArray(deltas)) fail(where, `opts.diffFn must return an array of Delta, got ${typeof deltas}`);

  return {
    type: 'CORRECT',
    claimId: target.id,
    cid: proposal.candidate.cid,
    status: 'CORRECTED',
    reason: proposal.reason,
    canonical: 'new_version_recorded_alongside_prior',
    priorClaimId: target.id,
    deltas
  };
}

/* -------------------------------------------------------------------------- */
/* CHALLENGE                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * applyChallenge(proposal, claims?) -> a single verdict.
 *
 * status is CHALLENGED — a third canonical state, deliberately distinct from
 * both ACCEPT and REJECT (threat-model §4: "the claim remains in history but
 * can move into a challenged/untrusted state"). Passing `claims` is
 * optional; when supplied, a targetClaimId that does not resolve fails
 * closed as INVALID rather than silently producing a CHALLENGED verdict
 * against nothing.
 */
export function applyChallenge(proposal, claims) {
  const where = 'applyChallenge';
  if (!isPlainObject(proposal) || proposal.type !== 'CHALLENGE') fail(where, 'proposal.type must be CHALLENGE (build it with makeProposal)');

  if (Array.isArray(claims)) {
    const target = claims.find((c) => c.id === proposal.targetClaimId);
    if (!target) {
      return {
        type: 'CHALLENGE',
        claimId: proposal.targetClaimId,
        cid: proposal.targetCid ?? null,
        status: 'INVALID',
        reason: 'target_claim_not_found',
        canonical: 'unchanged'
      };
    }
  }

  return {
    type: 'CHALLENGE',
    claimId: proposal.targetClaimId,
    cid: proposal.targetCid ?? null,
    status: 'CHALLENGED',
    challenger: proposal.challenger,
    reason: proposal.reason,
    canonical: 'disputed'
  };
}

/* -------------------------------------------------------------------------- */
/* ATTEST                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * applyAttest(proposal, claims?) -> a single verdict.
 *
 * status is ATTESTED. canonical is always 'unchanged' — an ATTEST is a
 * third-party vouch stored alongside the claim; it never mutates the claim
 * it attests to, and this function has no code path that would.
 */
export function applyAttest(proposal, claims) {
  const where = 'applyAttest';
  if (!isPlainObject(proposal) || proposal.type !== 'ATTEST') fail(where, 'proposal.type must be ATTEST (build it with makeProposal)');

  if (Array.isArray(claims)) {
    const target = claims.find((c) => c.id === proposal.targetClaimId);
    if (!target) {
      return {
        type: 'ATTEST',
        claimId: proposal.targetClaimId,
        cid: null,
        status: 'INVALID',
        reason: 'target_claim_not_found',
        canonical: 'unchanged'
      };
    }
  }

  const verdict = {
    type: 'ATTEST',
    claimId: proposal.targetClaimId,
    cid: null,
    status: 'ATTESTED',
    attester: proposal.attester,
    canonical: 'unchanged'
  };
  if (proposal.statement !== undefined) verdict.statement = proposal.statement;
  if (proposal.signature !== undefined) verdict.signature = proposal.signature;
  return verdict;
}

/* -------------------------------------------------------------------------- */
/* applyProposal — one dispatcher, so a caller never has to switch on type   */
/* -------------------------------------------------------------------------- */

/**
 * applyProposal(proposal, context) -> { verdicts: [...], report? }
 *
 * `context`:
 *   claims        Claim[] — existing canonical claims. Required for
 *                 PROPOSE_UPDATE/CORRECT; used as the default parentClaims
 *                 source for DERIVE when parentClaims is omitted; used to
 *                 validate targetClaimId for CHALLENGE/ATTEST when supplied.
 *   parentClaims  Claim[] — override source of parent claims for DERIVE.
 *                 Defaults to `claims`.
 *   hop           required for PROPOSE_UPDATE and CORRECT.
 *   opts          forwarded to gate() (PROPOSE_UPDATE) / diffFn (CORRECT).
 *
 * `report` is present only for PROPOSE_UPDATE, since only gate() produces
 * one — DERIVE/CORRECT/CHALLENGE/ATTEST are not diffed against a single
 * origin the way a Report's alignments/deltas assume.
 */
export function applyProposal(rawProposal, context = {}) {
  const where = 'applyProposal';
  if (!isPlainObject(rawProposal)) fail(where, 'proposal must be an object built with makeProposal()');
  // Re-validate through makeProposal rather than trusting rawProposal.type —
  // otherwise a caller could hand-build an object with a valid `type` string
  // but missing the fields that type requires, and dispatch would reach the
  // real gate()/diffClaim with garbage. This is what makes "requires an
  // explicit, well-formed transition wrapper" (threat-model §4) an enforced
  // property of this function, not just a naming convention callers can
  // route around.
  const proposal = makeProposal(rawProposal);
  const { claims = [], parentClaims = claims, hop, opts } = context;

  switch (proposal.type) {
    case 'PROPOSE_UPDATE': {
      if (!Number.isInteger(hop)) fail(where, 'context.hop is required for PROPOSE_UPDATE');
      return applyProposeUpdate(proposal, claims, hop, opts);
    }
    case 'DERIVE':
      return { verdicts: [applyDerive(proposal, parentClaims)] };
    case 'CORRECT': {
      if (!Number.isInteger(hop)) fail(where, 'context.hop is required for CORRECT (passed through to diffFn)');
      return { verdicts: [applyCorrect(proposal, claims, hop, opts)] };
    }
    case 'CHALLENGE':
      return { verdicts: [applyChallenge(proposal, claims)] };
    case 'ATTEST':
      return { verdicts: [applyAttest(proposal, claims)] };
    /* c8 ignore next 2 -- unreachable: TRANSITION_TYPES.includes already refused any other value */
    default:
      return fail(where, `unhandled type ${proposal.type}`);
  }
}
