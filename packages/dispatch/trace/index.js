/**
 * QUORUM dispatch — trace/index.js
 *
 * Phase 6 (plan §"Explainability and the loop closed"): the signed execution
 * trace. This is the artifact that closes the loop end to end — one object
 * summarizing everything that happened for a task's route decision (intake
 * -> profile -> plan -> execute -> merge -> predicted-vs-actual), fit for a
 * dashboard and independently verifiable via `packages/sign`.
 *
 * Two responsibilities, deliberately kept apart:
 *   - `assembleExecutionTrace()` — pure, deterministic, no I/O, no signing,
 *     no wall-clock reads. Builds the trace object from already-computed
 *     pieces (a route decision, batch results, a merge result, and the
 *     outcome comparisons from `trace/outcome.js`).
 *   - `signExecutionTrace()` / `verifyExecutionTrace()` — thin wrappers over
 *     `packages/sign`'s `signBundle()`/`verifyBundle()`. `packages/sign`
 *     signs ANY canonicalizable JSON object (see its own header: "no schema
 *     restriction") — so signing a trace needs zero changes to that
 *     package, and this module does not reimplement any signing logic.
 *
 * PRIVACY: `task` here is a SUMMARY (taskId/kind/workloadType/
 * workloadConfidence/itemCount) — the full `task.items` content is
 * deliberately never included. A signed trace is meant to be dashboard-
 * renderable and possibly shared for the demo; leaking full document/item
 * text into it would defeat the point of a claim-envelope architecture that
 * exists specifically to keep raw content out of anything downstream of
 * execution (see `executor/envelope.js`'s file header).
 *
 * DETERMINISM: matching this project's established convention (see
 * `ledger/reputation.js`'s `recordPrediction`/`recordOutcome`, which accept a
 * `timestamp` parameter rather than reading the clock deep inside pure
 * logic), `assembleExecutionTrace()` NEVER calls `new Date()`/`Date.now()`
 * internally. `assembledAt` is a REQUIRED input, supplied by the caller (the
 * "thin wrapper" / call site) — there is no default here, so the same inputs
 * always produce the exact same trace object, which is what makes this
 * function unit-testable and what makes a signature over it meaningful (a
 * function that quietly stamped its own timestamp would make every signed
 * trace unreproducible even in a test).
 */

import { signBundle, verifyBundle } from '../../sign/index.js';

/**
 * Assemble one execution trace for a task's route decision.
 *
 * @param {object} args
 * @param {object} args.task - a `route-contracts.js` task (`buildTaskRequest()`
 *   shape). Only `taskId`/`kind`/`items.length` are read — full item content
 *   is never included (see file header "PRIVACY").
 * @param {{workloadType?: string, confidence?: number}} [args.workloadClassification] -
 *   `profiling/classify.js`'s `classifyWorkload()` result.
 * @param {object} args.routeDecision - a `route-contracts.js` RouteDecision
 *   (`buildRouteDecision()` shape, or `dispatcher/policy.js`'s
 *   `decideRoute()` approved shape) — `decisionId`/`primaryProvider`/
 *   `batchPlan`/`qualityTarget`/`reasoning` are read.
 * @param {Array<{provider?:string, batchIndex?:number, outcome?:{status:string, actualTokens?:number, latencyMs?:number}}>} [args.batchResults] -
 *   one entry per executed batch, matching `merge/index.js`'s `mergeRoute()`
 *   own `batchResults` parameter shape (also accepts a bare outcome object
 *   per entry, same as that function).
 * @param {ReturnType<typeof import('../merge/index.js').mergeRoute>} [args.mergeResult] -
 *   `merge/index.js`'s `mergeRoute()` return value.
 * @param {Array} [args.outcomeComparisons] - one `trace/outcome.js`'s
 *   `compareOutcome()` result per batch, in batch order.
 * @param {string} args.assembledAt - REQUIRED ISO timestamp, supplied by the
 *   caller (see file header "DETERMINISM" — this function never generates
 *   its own).
 * @returns {{
 *   traceId: string,
 *   task: {taskId:string|null, kind:string|null, workloadType:string|null, workloadConfidence:number|null, itemCount:number},
 *   routeDecision: {decisionId:string|null, primaryProvider:string|null, batchPlan:object[], qualityTarget:number|null, reasoning:object},
 *   execution: {batchCount:number, successCount:number, failureCount:number, totalActualTokens:number, totalLatencyMs:number},
 *   merge: {status:string|null, contradictionCount:number, agreementCount:number, unmatchedCount:number},
 *   outcomeComparisons: object[],
 *   assembledAt: string
 * }}
 */
export function assembleExecutionTrace({
  task,
  workloadClassification,
  routeDecision,
  batchResults,
  mergeResult,
  outcomeComparisons,
  assembledAt
} = {}) {
  if (typeof assembledAt !== 'string' || assembledAt.trim().length === 0) {
    throw new Error(
      'assembleExecutionTrace: assembledAt (an ISO timestamp string) is required. ' +
        'This function is pure and never reads the wall clock itself — pass one from the call site.'
    );
  }
  if (!task || typeof task !== 'object') {
    throw new Error('assembleExecutionTrace: task is required');
  }
  if (!routeDecision || typeof routeDecision !== 'object') {
    throw new Error('assembleExecutionTrace: routeDecision is required');
  }

  const results = Array.isArray(batchResults) ? batchResults : [];
  const outcomeOf = (entry) => entry?.outcome ?? entry ?? {};
  const successResults = results.filter((entry) => outcomeOf(entry).status === 'success');

  const totalActualTokens = results.reduce((sum, entry) => {
    const tokens = outcomeOf(entry).actualTokens;
    return sum + (Number.isFinite(tokens) ? tokens : 0);
  }, 0);
  const totalLatencyMs = results.reduce((sum, entry) => {
    const latency = outcomeOf(entry).latencyMs;
    return sum + (Number.isFinite(latency) ? latency : 0);
  }, 0);

  const merge = mergeResult && typeof mergeResult === 'object' ? mergeResult : {};
  const verification = merge.verification && typeof merge.verification === 'object'
    ? merge.verification
    : { contradictions: [], agreements: [], unmatched: [] };

  return {
    traceId: `trace-${task.taskId ?? 'unknown-task'}-${routeDecision.decisionId ?? 'unknown-route'}`,
    task: {
      taskId: task.taskId ?? null,
      kind: task.kind ?? null,
      workloadType: workloadClassification?.workloadType ?? null,
      workloadConfidence: Number.isFinite(workloadClassification?.confidence) ? workloadClassification.confidence : null,
      itemCount: Array.isArray(task.items) ? task.items.length : 0
    },
    routeDecision: {
      decisionId: routeDecision.decisionId ?? null,
      primaryProvider: routeDecision.primaryProvider ?? null,
      batchPlan: Array.isArray(routeDecision.batchPlan) ? routeDecision.batchPlan : [],
      qualityTarget: Number.isFinite(routeDecision.qualityTarget) ? routeDecision.qualityTarget : null,
      reasoning: routeDecision.reasoning ?? {}
    },
    execution: {
      batchCount: results.length,
      successCount: successResults.length,
      failureCount: results.length - successResults.length,
      totalActualTokens,
      totalLatencyMs
    },
    merge: {
      status: merge.status ?? null,
      contradictionCount: Array.isArray(verification.contradictions) ? verification.contradictions.length : 0,
      agreementCount: Array.isArray(verification.agreements) ? verification.agreements.length : 0,
      unmatchedCount: Array.isArray(verification.unmatched) ? verification.unmatched.length : 0
    },
    outcomeComparisons: Array.isArray(outcomeComparisons) ? outcomeComparisons : [],
    assembledAt
  };
}

/**
 * Sign a trace object with an agent/operator's ed25519 identity. A thin
 * wrapper over `packages/sign`'s `signBundle()` — no reimplementation of
 * signing logic, and no schema imposed on `trace` beyond "a plain
 * JSON-serializable object", exactly as `signBundle()` itself requires.
 *
 * @param {object} trace - `assembleExecutionTrace()`'s return value (or any
 *   plain object — `signBundle()` places no restriction on shape).
 * @param {string} privateKey - PKCS8 DER, base64, from `generateIdentity()`.
 * @param {string} publicKey - SPKI DER, base64, from `generateIdentity()`.
 * @returns {{ trace: object, attestation: {signature:string, publicKey:string, keyId:string, signedAt:string} }}
 */
export function signExecutionTrace(trace, privateKey, publicKey) {
  const attestation = signBundle(trace, privateKey, publicKey);
  return { trace, attestation };
}

/**
 * Verify a signed trace. A thin wrapper over `packages/sign`'s
 * `verifyBundle()`, reusing its exact fail-closed contract: NEVER throws,
 * returns `false` on any tampering, a malformed signature, or a malformed
 * input — the same guarantee `verifyBundle()` already makes, so a caller
 * never needs a try/catch around "is this trace genuine."
 *
 * @param {{trace:object, attestation:{signature:string, publicKey:string}}} signedTrace -
 *   `signExecutionTrace()`'s return shape.
 * @returns {boolean}
 */
export function verifyExecutionTrace(signedTrace) {
  if (!signedTrace || typeof signedTrace !== 'object') return false;
  const { trace, attestation } = signedTrace;
  if (!trace || typeof trace !== 'object') return false;
  if (!attestation || typeof attestation !== 'object') return false;

  return verifyBundle(trace, attestation.signature, attestation.publicKey);
}
