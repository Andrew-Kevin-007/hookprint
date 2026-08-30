/**
 * bin/lib/runView.js — the live rendering layer for `quorum run`.
 *
 * QUORUM's whole value proposition is "you can verify what actually
 * happened" — so `quorum run`'s terminal output is a first-class part of
 * the product, not an afterthought. This module renders all seven pipeline
 * stages (intake -> profile -> predict -> route -> execute -> merge ->
 * verify) with EQUAL visual weight, grounded entirely in the real fields
 * each stage's real function actually returns (see the JSDoc on each
 * render* function below for exactly which module/function that data comes
 * from — nothing here is fabricated).
 *
 * Every function in this file is a PURE STRING BUILDER: given already-
 * computed pipeline data, return the line(s) to print. No I/O, no pipeline
 * logic, no side effects — matching this codebase's existing separation
 * (see e.g. merge/index.js's own file header: "this module does no I/O
 * itself"). `bin/quorum.js`'s cmdRun() is the only caller, and is the only
 * place that actually calls console.log()/Spinner — this keeps the actual
 * pipeline-calling code in cmdRun() readable as a straight-line sequence of
 * "do the real work, then render it" pairs, one per stage.
 *
 * Every helper here is built on bin/lib/ui.js's primitives (stageHeader,
 * statusLine, renderChain, treeLines, progressBar, Spinner) — PLAIN_MODE
 * degradation is entirely ui.js's responsibility; nothing here special-cases
 * it, which is what guarantees this file can't reintroduce a piped-output
 * bug ui.js already solved once.
 */

import { accent, bold, dim, progressBar, red, renderChain, stageHeader, statusLine, treeLines } from './ui.js';

/** Stage 1/7 — INTAKE: the task request as built (route-contracts.js's
 * `buildTaskRequest()`), before anything is classified or routed. */
export function renderIntakeStage({ taskId, itemCount, availableProviders }) {
  return [
    stageHeader(1, 7, 'INTAKE'),
    `  task ${bold(taskId)} — ${itemCount} item(s)`,
    `  funded providers: ${availableProviders.join(', ')}`
  ].join('\n');
}

/**
 * Format one `profiling/classify.js` `classifyWorkload()` signal record
 * (`{workloadType, score, evidence: string[]}`) into one readable line —
 * the classifier's own auditability guarantee ("why did this task classify
 * as X" has a real answer, see that file's header) is only real if this
 * view actually renders `evidence`, not just the bare object.
 */
function formatSignal(signal) {
  if (typeof signal === 'string') return signal;
  const evidence = Array.isArray(signal?.evidence) ? signal.evidence.join('; ') : 'no evidence recorded';
  return `${signal?.workloadType ?? 'unknown'} (score ${Number(signal?.score ?? 0).toFixed(3)}): ${evidence}`;
}

/**
 * Stage 2/7 — PROFILE: the workload classification `route-contracts.js`'s
 * `analyzeTaskQuality()` produces via `profiling/classify.js`'s
 * `classifyWorkload()` — a workload type, a confidence, and (when present)
 * the concrete signals that drove the classification.
 */
export function renderProfileStage({ workloadType, confidence, signals }) {
  const lines = [
    stageHeader(2, 7, 'PROFILE'),
    `  ${statusLine('ok', `workload classified: ${bold(workloadType)} (confidence ${confidence.toFixed(2)})`)}`
  ];
  if (Array.isArray(signals) && signals.length > 0) {
    lines.push('  signals:', ...treeLines(signals.map(formatSignal)));
  }
  return lines.join('\n');
}

/**
 * Stage 3/7 — PREDICT: predicted quality per (provider, batch size) BEFORE
 * any execution happens — `provider-profiles.js`'s `rankProviders()`
 * result, already sorted best-quality-first. `topProvider` (the one
 * `cmdRun()` will actually route to, via the operator-override path) is
 * highlighted so a viewer can see the prediction driving the next stage's
 * decision, not just a disconnected table.
 */
export function renderPredictStage({ ranked, topProvider }) {
  const lines = [stageHeader(3, 7, 'PREDICT'), '  predicted quality per provider (before executing):'];
  const rows = ranked.map((r) => {
    const label = `${r.provider}`.padEnd(11);
    const line = `${label} quality=${r.qualityEstimate.toFixed(3)}  batches=${r.totalBatches} (batch size ${r.safeBatch})  ~${r.estimatedTokens} tokens`;
    return r.provider === topProvider ? accent(bold(`${line}  ← selected`)) : dim(line);
  });
  lines.push(...treeLines(rows));
  return lines.join('\n');
}

/**
 * Stage 4/7 — ROUTE: the real `dispatcher/policy.js` `decideRoute()`
 * decision — primary provider, ranked fallback chain, the batch plan
 * (`{batchIndex, itemIds, expectedTokens}[]`), quality target, and any
 * warnings its `reasoning` carries (e.g. the operator-override path's
 * standing "bypasses policy evaluation" warning).
 */
export function renderRouteStage({ decision }) {
  const lines = [
    stageHeader(4, 7, 'ROUTE'),
    `  routed to ${bold(decision.primaryProvider)}  fallback chain: ${renderChain(decision.fallbackProviders)}`,
    `  ${decision.batchPlan.length} batch(es) planned, quality target ${decision.qualityTarget.toFixed(2)}`
  ];
  const batchRows = decision.batchPlan.map(
    (bp) => `batch ${bp.batchIndex}: ${bp.itemIds.length} item(s), ~${bp.expectedTokens} tokens`
  );
  lines.push(...treeLines(batchRows));
  const warnings = decision.reasoning?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    lines.push(...warnings.map((w) => `  ${statusLine('warn', w)}`));
  }
  return lines.join('\n');
}

/** Stage 5/7 — EXECUTE header, printed once before the per-batch spinners
 * (each batch renders its own progress via ui.js's Spinner directly from
 * cmdRun(), since that is genuinely asynchronous, live-updating output). */
export function renderExecuteStageHeader({ batchCount }) {
  return `${stageHeader(5, 7, 'EXECUTE')}\n  running ${batchCount} batch(es)`;
}

/**
 * One batch's in-flight spinner label, including a `current/total` batch
 * progress indicator so a viewer can see how far through the run is even
 * while a single batch is still executing. No leading indent here —
 * `Spinner` itself prepends its frame/icon flush-left (`\`${frame} ${label}\``,
 * see ui.js), so an indent baked into the label would double up with it.
 */
export function batchAttemptLabel({ batchIndex, batchPosition, batchCount, providerName }) {
  return `[${progressBar(batchPosition, batchCount)}] batch ${batchIndex} — running on ${providerName}...`;
}

/** One batch's settled success line — real measured tokens/latency from
 * `executor/index.js`'s `executeBatch()` outcome, never a prediction. */
export function batchSuccessLine({ batchIndex, providerName, outcome }) {
  return `batch ${batchIndex} completed via ${bold(providerName)} — ${outcome.actualTokens} tokens, ${outcome.latencyMs}ms`;
}

/** One batch attempt's failure line — the real outcome status/errorClass
 * `executeBatch()` returned, plus `dispatcher/policy.js`'s `decideFallback()`
 * reasoning for why it either retries, moves to the next fallback, or gives
 * up. Rendered honestly even on the terminal failure (fallback chain
 * exhausted) — never swallowed. */
export function batchFailureLine({ batchIndex, providerName, outcome, fallback }) {
  const errorTag = outcome.errorClass ? `, ${outcome.errorClass}` : '';
  const base = `batch ${batchIndex} failed on ${providerName} (${outcome.status}${errorTag}) — ${fallback.reason}`;
  if (fallback.retry && fallback.nextProvider) {
    return `${base}\n    ↳ falling back to ${bold(fallback.nextProvider)}`;
  }
  return `${base}\n    ${statusLine('fail', 'no further fallback — this batch did not complete')}`;
}

/**
 * Stage 6/7 — MERGE: `merge/index.js`'s `mergeRoute()` result — status,
 * cross-batch verification counts, any failed batches (rendered, never
 * silently dropped), any contradictions found (with the actual disagreeing
 * claims, not just a count), and every successfully-parsed batch's quality
 * score breakdown.
 */
export function renderMergeStage({ mergeResult }) {
  const { status, verification, failedBatches, qualityScores } = mergeResult;
  const statusKind = status === 'CLEAN' ? 'ok' : status === 'CONTRADICTIONS_FOUND' ? 'warn' : 'fail';
  const lines = [
    stageHeader(6, 7, 'MERGE'),
    `  ${statusLine(statusKind, `status: ${status}`)}`,
    `  ${verification.agreements.length} agreement(s), ${verification.contradictions.length} contradiction(s), ${verification.unmatched.length} unmatched`
  ];

  if (failedBatches.length > 0) {
    lines.push('  failed batches:');
    lines.push(...treeLines(failedBatches.map((f) => red(`batch ${f.batchIndex} (${f.provider}): ${f.reason}`))));
  }

  if (verification.contradictions.length > 0) {
    lines.push('  contradictions:');
    lines.push(
      ...treeLines(
        verification.contradictions.map((c) => {
          const a = c.claimA;
          const b = c.claimB;
          return red(
            `"${a.claim.subject}": ${a.claim.value} (${a.provider}, batch ${a.batchIndex}) vs ${b.claim.value} (${b.provider}, batch ${b.batchIndex}) — ${c.comparison.reason}`
          );
        })
      )
    );
  }

  if (qualityScores.length > 0) {
    lines.push('  quality scores:');
    lines.push(
      ...treeLines(
        qualityScores.map(
          (qs) =>
            `batch ${qs.batchIndex} (${qs.provider}): combined=${qs.combinedScore.toFixed(3)} ` +
            `(deterministic ${qs.deterministicScore.toFixed(3)}, consistency ${qs.consistencyScore.toFixed(3)})`
        )
      )
    );
  }

  return lines.join('\n');
}

/**
 * Stage 7/7 — VERIFY: the signed execution trace (`trace/index.js`'s
 * `assembleExecutionTrace()` + `signExecutionTrace()`) and the real
 * `verifyExecutionTrace()` boolean — QUORUM's actual "you can verify what
 * happened" claim made concrete. `verified: false` is rendered as loudly as
 * `true` is, never softened — a failed verification here is the single most
 * important line this whole view can produce.
 */
export function renderVerifyStage({ traceId, meanOutcomeAccuracy, keyId, verified }) {
  const accuracyText = Number.isFinite(meanOutcomeAccuracy) ? meanOutcomeAccuracy.toFixed(4) : 'n/a (no comparable batches)';
  const lines = [
    stageHeader(7, 7, 'VERIFY'),
    `  trace ${traceId}`,
    `  mean outcome accuracy (predicted vs. actual): ${accuracyText}`,
    `  signed: ed25519, keyId ${keyId}`,
    `  ${statusLine(verified ? 'ok' : 'fail', `verifyExecutionTrace() = ${verified}`)}`
  ];
  if (!verified) {
    lines.push(`  ${statusLine('fail', 'the signed trace failed verification — do not trust this run\'s attestation')}`);
  }
  return lines.join('\n');
}
