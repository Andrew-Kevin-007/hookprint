/**
 * QUORUM dispatch — merge/index.js
 *
 * The absent step 6 (plan §"Blocker 2"): given a RouteDecision and every
 * batch's raw execution outcome (`executor/index.js`'s `executeBatch()`
 * return shape), produce ONE merged answer with per-claim provenance and a
 * cross-batch verification report — never silently picking a winner when
 * batches disagree, and never silently omitting a batch that failed to
 * produce a usable answer.
 *
 * This module does no I/O itself (same separation `executor/index.js` uses:
 * `executeBatch()` never appends to the ledger either) — `buildMergeLedgerEvent()`
 * builds the event object, and the caller appends it via `ledger/store.js`'s
 * `appendEvent()`, exactly as `executor/index.js`'s `buildExecutionLedgerEvent()`
 * already works.
 */

import { createLedgerEvent } from '../execution-contracts.js';
import { parseEnvelope } from '../executor/envelope.js';
import { crossCheckBatches } from './consistency.js';

function formatBatchLabel(provider, batchIndex) {
  return `batch ${batchIndex ?? '?'} (${provider ?? 'unknown provider'})`;
}

function buildProvenance(parsedBatches) {
  const provenance = [];
  for (const batch of parsedBatches) {
    for (const claim of batch.envelope.claims) {
      provenance.push({
        claimSubject: claim.subject,
        value: claim.value,
        sourceProvider: batch.provider,
        sourceBatchIndex: batch.batchIndex
      });
    }
  }
  return provenance;
}

function buildAnswer({ parsedBatches, failedBatches, contradictions }) {
  const sections = [];

  if (failedBatches.length > 0) {
    const lines = failedBatches.map((f) => `- ${formatBatchLabel(f.provider, f.batchIndex)}: ${f.reason}`);
    sections.push(
      `INCOMPLETE: ${failedBatches.length} of ${failedBatches.length + parsedBatches.length} batch(es) could not be verified and are excluded below:\n${lines.join('\n')}`
    );
  }

  if (contradictions.length > 0) {
    sections.push(
      `CONTRADICTIONS FOUND: ${contradictions.length} pair(s) of claims disagree across batches (see verification.contradictions for the full comparison). This merge does not adjudicate which side is correct.`
    );
  }

  if (parsedBatches.length === 0) {
    sections.push('No batch produced a usable answer.');
  } else {
    sections.push(parsedBatches.map((b) => `${formatBatchLabel(b.provider, b.batchIndex)}: ${b.envelope.answer}`).join('\n\n'));
  }

  return sections.join('\n\n');
}

/**
 * Merge every batch's execution outcome for one route into a single result.
 *
 * @param {object} routeDecision - a route-contracts.js RouteDecision (used
 *   only for `taskId`/`decisionId` linkage; not required to call this).
 * @param {Array<{provider:string, batchIndex:number, outcome:{status:string, output:string|null, errorClass?:string|null}}>} batchResults -
 *   one entry per executed batch, shaped exactly like `executor/index.js`'s
 *   `executeBatch()` return value plus the `provider`/`batchIndex` that
 *   identify which batch it was.
 * @returns {{
 *   answer: string,
 *   provenance: Array<{claimSubject:string, value:number, sourceProvider:string, sourceBatchIndex:number}>,
 *   verification: {contradictions:object[], agreements:object[], unmatched:object[]},
 *   status: 'CLEAN'|'CONTRADICTIONS_FOUND'|'INCOMPLETE',
 *   failedBatches: Array<{provider:string, batchIndex:number, reason:string}>
 * }}
 */
export function mergeRoute(routeDecision, batchResults) {
  const results = Array.isArray(batchResults) ? batchResults : [];

  const parsedBatches = [];
  const failedBatches = [];

  for (const entry of results) {
    const provider = entry?.provider ?? entry?.outcome?.provider ?? 'unknown';
    const batchIndex = Number.isInteger(entry?.batchIndex) ? entry.batchIndex : null;
    const outcome = entry?.outcome ?? entry;

    if (!outcome || outcome.status !== 'success') {
      const status = outcome?.status ?? 'unknown';
      const errorClass = outcome?.errorClass ? `, errorClass: ${outcome.errorClass}` : '';
      failedBatches.push({ provider, batchIndex, reason: `execution did not succeed (status: ${status}${errorClass})` });
      continue;
    }

    const parsed = parseEnvelope(outcome.output);
    if (!parsed.valid) {
      failedBatches.push({ provider, batchIndex, reason: `envelope failed to parse: ${parsed.reason}` });
      continue;
    }

    parsedBatches.push({ provider, batchIndex, envelope: parsed.envelope });
  }

  const verification = crossCheckBatches(parsedBatches);
  const provenance = buildProvenance(parsedBatches);

  const status =
    failedBatches.length > 0
      ? 'INCOMPLETE'
      : verification.contradictions.length > 0
        ? 'CONTRADICTIONS_FOUND'
        : 'CLEAN';

  const answer = buildAnswer({ parsedBatches, failedBatches, contradictions: verification.contradictions });

  return { answer, provenance, verification, status, failedBatches };
}

/**
 * Build the ledger event for a merge outcome — one event type per
 * `mergeRoute()` status (see execution-contracts.js's `LEDGER_EVENT_TYPES`
 * comment for why these three exist rather than reusing `task-completed`/
 * `task-failed`). Does not append it — pass the result to `ledger/store.js`'s
 * `appendEvent()`, same as `executor/index.js`'s `buildExecutionLedgerEvent()`.
 *
 * @param {object} routeDecision
 * @param {ReturnType<typeof mergeRoute>} mergeResult
 * @param {{taskId?:string, provider?:string|null}} [opts]
 */
export function buildMergeLedgerEvent(routeDecision, mergeResult, opts = {}) {
  const eventType =
    mergeResult.status === 'CLEAN'
      ? 'merge-completed'
      : mergeResult.status === 'CONTRADICTIONS_FOUND'
        ? 'merge-contradiction-found'
        : 'merge-incomplete';

  return createLedgerEvent({
    eventType,
    taskId: opts.taskId ?? routeDecision?.taskId,
    // A merge spans multiple providers by design — no single provider owns
    // the outcome, so `provider` is left null unless the caller has a
    // reason to attribute it to one (e.g. a single-batch route).
    provider: opts.provider ?? null,
    routeId: routeDecision?.decisionId ?? null,
    payload: {
      status: mergeResult.status,
      contradictionCount: mergeResult.verification.contradictions.length,
      agreementCount: mergeResult.verification.agreements.length,
      unmatchedCount: mergeResult.verification.unmatched.length,
      failedBatches: mergeResult.failedBatches
    }
  });
}
