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
import { appendEvent } from '../ledger/store.js';
import { scoreBatch, buildQualityScoreEvent } from '../quality/score.js';
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
 * @param {Array<{provider:string, batchIndex:number, outcome:{status:string, output:string|null, errorClass?:string|null}, batch?:Array, originalItems?:Array, contextRatio?:number}>} batchResults -
 *   one entry per executed batch, shaped exactly like `executor/index.js`'s
 *   `executeBatch()` return value plus the `provider`/`batchIndex` that
 *   identify which batch it was. `batch`/`originalItems` (the items actually
 *   sent to the provider for this batch) and `contextRatio` (from
 *   `route-contracts.js`'s `estimateProviderFit()`) are OPTIONAL additive
 *   fields consumed only by Phase 2's quality scoring below — omitting them
 *   degrades the deterministic grounding/truncation checks gracefully (see
 *   `quality/score.js`'s `scoreDeterministic()`) rather than throwing, so
 *   every pre-existing caller of this function keeps working unchanged.
 * @param {{ledgerPath?:string, workloadType?:string|null, workloadClassification?:{workloadType?:string|null}}} [options] -
 *   when `ledgerPath` is given, one `'batch-quality-scored'` ledger event is
 *   appended per successfully-parsed batch (see `quality/score.js`'s
 *   `buildQualityScoreEvent()`). Omitted (the default), `mergeRoute()`
 *   performs NO I/O, exactly as before this phase — this function's own file
 *   header states "this module does no I/O itself", and there is no ledger
 *   path already threaded through it to reuse (the existing
 *   `buildMergeLedgerEvent()` below is a pure builder the CALLER appends via
 *   `ledger/store.js`'s `appendEvent()`, e.g. in `tests/merge.test.js`'s
 *   integration test — there is no site inside this file that already calls
 *   `appendEvent()`). This optional param is a deliberate, minimal addition
 *   for the one thing the task brief asks this function to do that its pure
 *   builder-only convention cannot: write to the ledger AS PART OF calling
 *   `mergeRoute()`, without an unconditional, always-on side effect change
 *   for every existing caller.
 *
 *   `options.workloadType` / `options.workloadClassification` (OPTIONAL,
 *   ADDITIVE — closes the gap `ledger/curves.js`'s file header used to
 *   document as future work): the caller's `profiling/classify.js`
 *   `classifyWorkload(task)` result for the task this route belongs to.
 *   Accepts EITHER a bare `workloadType` string, OR the whole classification
 *   object (from which `.workloadType` is read) — whichever a caller already
 *   has on hand. `options.workloadType` wins if both are given. Threaded
 *   straight through to every `buildQualityScoreEvent()` call this function
 *   makes, so each recorded `'batch-quality-scored'` event carries which
 *   workload type produced it. Omitted (the default): every event this
 *   function builds is IDENTICAL to today's shape — no `workloadType` key at
 *   all (see `buildQualityScoreEvent()`'s own docstring) — so no existing
 *   caller's recorded events change shape. Has no effect at all when
 *   `ledgerPath` is also omitted, since no event is built in that case.
 * @returns {{
 *   answer: string,
 *   provenance: Array<{claimSubject:string, value:number, sourceProvider:string, sourceBatchIndex:number}>,
 *   verification: {contradictions:object[], agreements:object[], unmatched:object[]},
 *   status: 'CLEAN'|'CONTRADICTIONS_FOUND'|'INCOMPLETE',
 *   failedBatches: Array<{provider:string, batchIndex:number, reason:string}>,
 *   qualityScores: Array<{provider:string, batchIndex:number, contextRatio:number|null, combinedScore:number, deterministicScore:number, consistencyScore:number, weights:object, reasons:string[]}>
 * }}
 */
export function mergeRoute(routeDecision, batchResults, options = {}) {
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

    parsedBatches.push({
      provider,
      batchIndex,
      envelope: parsed.envelope,
      // Kept alongside (not part of the public shape read by buildProvenance/
      // buildAnswer/crossCheckBatches, which only look at provider/batchIndex/
      // envelope) purely so Phase 2 scoring below has what it needs per batch.
      parseResult: parsed,
      batch: entry?.batch ?? null,
      originalItems: entry?.originalItems ?? null,
      contextRatio: Number.isFinite(entry?.contextRatio) ? entry.contextRatio : null
    });
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

  // Additive workload-type dimension (see this function's own JSDoc):
  // accepts either a bare string or the whole classifyWorkload() result.
  const workloadType = options.workloadType ?? options.workloadClassification?.workloadType ?? undefined;

  // Phase 2: score every successfully-parsed batch (deterministic + cross-
  // batch consistency), and record each to the ledger when a path was given.
  const qualityScores = parsedBatches.map((pb) => {
    const scoreResult = scoreBatch(pb.parseResult, pb.batch, pb.originalItems, pb.batchIndex, pb.provider, verification);

    if (options.ledgerPath) {
      const event = buildQualityScoreEvent({
        taskId: options.taskId ?? routeDecision?.taskId,
        provider: pb.provider,
        routeId: routeDecision?.decisionId ?? null,
        batchIndex: pb.batchIndex,
        contextRatio: pb.contextRatio,
        scoreResult,
        workloadType
      });
      appendEvent(options.ledgerPath, event);
    }

    return {
      provider: pb.provider,
      batchIndex: pb.batchIndex,
      contextRatio: pb.contextRatio,
      ...scoreResult
    };
  });

  return { answer, provenance, verification, status, failedBatches, qualityScores };
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
