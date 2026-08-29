/**
 * report.js — a plain-text terminal renderer for the {report, verdicts}
 * shape gate() (index.js) returns. This is the demo's visible output: read on
 * a projector during a 180-second pitch, not a full report. No clock, no
 * randomness, no network — rendering the same {report, verdicts} twice
 * produces the same string.
 *
 * Owns: human rendering. Depends on: nothing (pure string formatting over the
 * shape index.js hands it — no re-import of contract.js needed, since the
 * verdict shape already carries everything to render).
 */

/**
 * Render the full result of one gate() call: one block per verdict, then the
 * honesty-receipt summary (unaligned candidates, dropped claims).
 *
 * @param {{report: object, verdicts: Array}} result — gate()'s return value.
 * @returns {string}
 */
export function renderReport({ report, verdicts }) {
  const sections = verdicts.map(renderVerdict);
  sections.push(renderSummary(report));
  return sections.join('\n\n');
}

/**
 * One verdict, rendered:
 *
 *   REJECTED
 *   Claim: c_001
 *   Class: DENOMINATOR_LOSS
 *   Canonical: unchanged
 *   <the failing delta's message>
 *
 * or:
 *
 *   ACCEPTED
 *   Claim: c_001
 *   Canonical: updated
 *
 * An ambiguous-alignment REJECT carries no delta (gate() never calls diffFn
 * for one) — it prints its own explanation instead of a delta message.
 */
export function renderVerdict(v) {
  const lines = [];
  if (v.status === 'ACCEPT') {
    lines.push('ACCEPTED');
    lines.push(`Claim: ${v.claimId}`);
    lines.push('Canonical: updated');
    return lines.join('\n');
  }

  // REJECT
  lines.push('REJECTED');
  lines.push(`Claim: ${v.claimId}`);
  lines.push(`Class: ${String(v.reason).toUpperCase()}`);
  lines.push('Canonical: unchanged');

  const failDelta = (v.deltas || []).find((d) => d.severity === 'fail');
  if (failDelta) {
    lines.push(failDelta.message);
  } else if (v.reason === 'ambiguous_alignment') {
    lines.push('No restatement could be confidently identified for this claim — the best match was too close to call, so nothing was compared.');
  }
  return lines.join('\n');
}

/**
 * The honesty-receipt summary: unaligned candidates and dropped claims, with
 * counts by reason. Always rendered — never absent — so a non-empty receipt
 * is never mistaken for "nothing to report."
 */
export function renderSummary(report) {
  const lines = ['--- Honesty receipt ---'];

  lines.push(`Unaligned candidates: ${report.unaligned.length}`);
  for (const [reason, n] of countByReason(report.unaligned)) {
    lines.push(`  ${reason}: ${n}`);
  }

  lines.push(`Dropped claims: ${report.dropped_claims.length}`);
  for (const [reason, n] of countByReason(report.dropped_claims)) {
    lines.push(`  ${reason}: ${n}`);
  }

  return lines.join('\n');
}

function countByReason(items) {
  const counts = new Map();
  for (const it of items) {
    counts.set(it.reason, (counts.get(it.reason) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
