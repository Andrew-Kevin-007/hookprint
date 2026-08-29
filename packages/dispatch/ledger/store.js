/**
 * BATON dispatch — ledger/store.js
 *
 * Layer 1 (PRODUCT-ARCHITECTURE.md): the ledger is the single source of
 * ground truth for resource usage and agent prediction history. This module
 * is the durable, append-only backing store for it — newline-delimited JSON
 * (JSONL), one event object per line, one physical file. This matches the
 * project's existing "never silently overwrite, always append" convention
 * (see e.g. baton-registry's equivocation/replay stores: a conflicting or
 * stale record is stored/flagged, never silently dropped or overwritten).
 *
 * Ground-truth rule: `pools.json`-shaped state (PRODUCT-ARCHITECTURE.md
 * Layer 1) is never itself a separately-writable file here — that would let
 * it drift from the event log. `computePoolState()` below DERIVES that
 * shape by replaying events every time it is called. The log is the only
 * thing that is ever written; everything else is a read-time projection.
 *
 * Fail-closed contract: a corrupted or partial last line (the classic
 * crash-mid-append scenario — `appendFileSync` itself is not atomic against
 * a power loss between the write and the trailing newline) must never take
 * down `readEvents()` and must never lose the valid events that precede it.
 * Malformed lines are skipped and reported back to the caller, not thrown.
 * A missing ledger file is NOT an error — it means no events have been
 * recorded yet — but a file that exists and genuinely cannot be read (wrong
 * permissions, path is a directory, etc.) is reported via `readError`
 * rather than silently treated as "zero history," so a caller building a
 * reputation score can tell "brand new" apart from "something is actually
 * broken." Never throws for a read problem — same fail-closed shape as
 * `packages/sign`'s `verifyBundle`, which never throws either.
 */

import { existsSync, appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append one event to the ledger as a single JSONL line. Creates the parent
 * directory and the file itself on first use — callers never need to
 * pre-create a ledger path.
 *
 * @param {string} ledgerPath
 * @param {object} event - typically the output of execution-contracts.js's
 *   createLedgerEvent(), but this function does not require that shape; it
 *   only requires a plain, JSON-serializable object.
 * @returns {object} the same event, for chaining.
 */
export function appendEvent(ledgerPath, event) {
  if (!ledgerPath || typeof ledgerPath !== 'string') {
    throw new Error('appendEvent: ledgerPath must be a non-empty string');
  }
  if (!event || typeof event !== 'object') {
    throw new Error('appendEvent: event must be an object');
  }

  const dir = dirname(ledgerPath);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

/**
 * Read events back from the ledger, oldest-first (the order they were
 * appended), with basic filters applied.
 *
 * @param {string} ledgerPath
 * @param {{ since?: string, eventType?: string, taskId?: string }} [filters]
 *   `since` is an ISO timestamp; events strictly before it are excluded.
 * @returns {{
 *   events: object[],
 *   malformedLines: Array<{ lineNumber: number, error: string, preview: string }>,
 *   readError: { message: string, code: string|null } | null
 * }}
 *   `malformedLines` reports every line that failed to parse as JSON — the
 *   crash-mid-write case — WITHOUT throwing and without discarding the
 *   events that parsed correctly. `readError` is set only when the file
 *   exists but could not be opened/read at all (permissions, is a
 *   directory, etc.); a missing file yields `readError: null` with an empty
 *   `events` array, since "no ledger yet" is not a failure.
 */
export function readEvents(ledgerPath, { since, eventType, taskId } = {}) {
  if (!ledgerPath || !existsSync(ledgerPath)) {
    return { events: [], malformedLines: [], readError: null };
  }

  let raw;
  try {
    raw = readFileSync(ledgerPath, 'utf8');
  } catch (err) {
    return { events: [], malformedLines: [], readError: { message: err.message, code: err.code ?? null } };
  }

  const lines = raw.split('\n');
  const events = [];
  const malformedLines = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return; // blank lines, including the normal trailing newline, are not corruption

    try {
      events.push(JSON.parse(trimmed));
    } catch (err) {
      malformedLines.push({
        lineNumber: index + 1,
        error: err.message,
        preview: trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
      });
    }
  });

  const sinceMs = since ? Date.parse(since) : null;
  const filtered = events.filter((event) => {
    if (eventType && event?.eventType !== eventType) return false;
    if (taskId && event?.taskId !== taskId) return false;
    if (sinceMs != null) {
      const eventMs = Date.parse(event?.timestamp);
      if (!Number.isFinite(eventMs) || eventMs < sinceMs) return false;
    }
    return true;
  });

  return { events: filtered, malformedLines, readError: null };
}

/**
 * Derive current pool/burn-rate state for one provider by replaying the
 * ledger — PRODUCT-ARCHITECTURE.md Layer 1's `pools.json` shape
 * (total_quota / used_today / remaining / last_updated), but computed fresh
 * from the event log every call rather than maintained as separate mutable
 * state that could drift from it.
 *
 * Only events carrying real, measured usage count: `task-completed` and
 * `task-failed` events whose `payload.actualTokens` is a finite number and
 * whose top-level `provider` matches — exactly the shape
 * executor/index.js's `buildExecutionLedgerEvent()` produces. (A failed
 * batch's `actualTokens` is always 0 per that module's own contract — never
 * backfilled from the prediction — so including `task-failed` here is safe
 * and simply contributes 0 quota usage for a call that never completed.)
 *
 * `totalQuota` is not itself derivable from the event log (it is
 * operator-configured budget, not a measured quantity), so it is accepted
 * as an optional input; omitted, `remaining` is reported as `null` rather
 * than a misleading number.
 *
 * @param {string} ledgerPath
 * @param {string} providerName
 * @param {{ totalQuota?: number, now?: Date }} [opts]
 */
export function computePoolState(ledgerPath, providerName, opts = {}) {
  const { totalQuota = null, now = new Date() } = opts;

  const { events, malformedLines, readError } = readEvents(ledgerPath);

  const usageEvents = events.filter(
    (e) =>
      e?.provider === providerName &&
      (e?.eventType === 'task-completed' || e?.eventType === 'task-failed') &&
      Number.isFinite(e?.payload?.actualTokens)
  );

  const todayStr = now.toISOString().slice(0, 10);
  const todayEvents = usageEvents.filter((e) => typeof e.timestamp === 'string' && e.timestamp.slice(0, 10) === todayStr);

  const usedToday = todayEvents.reduce((sum, e) => sum + e.payload.actualTokens, 0);
  const usedTotal = usageEvents.reduce((sum, e) => sum + e.payload.actualTokens, 0);

  const lastUpdated = usageEvents.length
    ? usageEvents.reduce((latest, e) => (e.timestamp > latest ? e.timestamp : latest), usageEvents[0].timestamp)
    : null;

  // Burn rate: tokens/hour across today's observed window. With fewer than
  // two data points today there is no elapsed window to divide by, so the
  // rate is reported as 0 rather than a divide-by-near-zero spike.
  let burnRatePerHour = 0;
  if (todayEvents.length >= 2) {
    const sortedToday = [...todayEvents].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const firstMs = Date.parse(sortedToday[0].timestamp);
    const lastMs = Date.parse(sortedToday[sortedToday.length - 1].timestamp);
    const elapsedHours = Math.max((lastMs - firstMs) / (60 * 60 * 1000), 1 / 60); // floor at 1 minute
    burnRatePerHour = usedToday / elapsedHours;
  }

  const remaining = Number.isFinite(totalQuota) ? Math.max(0, totalQuota - usedToday) : null;

  return {
    provider: providerName,
    totalQuota: Number.isFinite(totalQuota) ? totalQuota : null,
    usedToday,
    usedTotal,
    remaining,
    burnRatePerHour,
    lastUpdated,
    eventCount: usageEvents.length,
    updateSource: 'local_ledger', // never from a provider API — PRODUCT-ARCHITECTURE.md Layer 1 invariant
    malformedLinesSkipped: malformedLines.length,
    readError
  };
}
