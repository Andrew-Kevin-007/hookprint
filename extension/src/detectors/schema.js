/**
 * HOOKPRINT — detector event schema.
 *
 * ============================================================================
 * THIS FILE IS THE ENTIRE COUPLING SURFACE BETWEEN THE DETECTORS AND THE
 * INSTRUMENTATION HARNESS (`instrument.js` / `bridge.js`, owned by edith).
 * ============================================================================
 *
 * Reconciled against `../EVENTS.md` v1 (frozen). Before that file existed this
 * module translated an *assumed* event shape into a normalised one via alias
 * tables. The guesswork is now gone: detectors consume the real v1 envelope
 * directly, unrenamed, so a fixture in `tests/` is literally an event out of
 * EVENTS.md. Nothing is translated, so nothing can be mistranslated.
 *
 * What survives from the guessing era is the part that was never a guess: the
 * refusal to accept a call site we cannot stand behind.
 *
 * ---------------------------------------------------------------------------
 * THE ENVELOPE (EVENTS.md §"The envelope")
 * ---------------------------------------------------------------------------
 *
 *   {
 *     v:     1,                       // schema version; anything else is refused
 *     seq:   412,                     // monotonic, per session. TOTAL ORDER.
 *     t:     3184.52,                 // performance.now(), page-relative ms
 *     type:  "timer.schedule",        // dotted namespace, see EVENT
 *     site:  { file, line, column, fn } | null,
 *     cause: { type, id, age_ms } | null,
 *     data:  { }                      // per-type; never null
 *   }
 *
 * `site: null` is a legitimate outcome, not a defect — an unsymbolized frame,
 * an async event with no originating frame, or a page that set
 * `Error.stackTraceLimit = 0`. Per CONTRACT.md rule 1 it sends a candidate to
 * `dropped`, and it never gets guessed at.
 *
 * `evidence.snippet` is deliberately NOT produced here. The MAIN world cannot
 * read cross-origin script source, so `worker.js` fetches and windows it after
 * the fact. Detectors emit `evidence` as `{file, line, column}` and stop.
 */

/**
 * @typedef {Object} CallSite
 * @property {string}      file    Full URL of the page's own script.
 * @property {number}      line    1-indexed.
 * @property {number}      column  1-indexed.
 * @property {string|null} [fn]    Function name. Decoration only, never load-bearing.
 */

/**
 * @typedef {Object} Cause
 * @property {"timer"|"observer"|"event"|null} type
 * @property {number|null} id      timer_id / observer_id of the running frame.
 * @property {number}      age_ms  0 when emitted synchronously inside that frame.
 */

/**
 * @typedef {Object} HookEvent
 * @property {number}         v
 * @property {number}         seq
 * @property {number}         t
 * @property {string}         type
 * @property {CallSite|null}  site
 * @property {Cause|null}     cause
 * @property {Object}         data
 */

/** The schema version these detectors understand. EVENTS.md: "Always `1`." */
export const SCHEMA_VERSION = 1;

/**
 * The event vocabulary, verbatim from EVENTS.md. 21 types, 7 namespaces.
 * Referenced by constant so a typo is a crash at import rather than a silent
 * zero-findings scan.
 */
export const EVENT = Object.freeze({
  SESSION_START: 'session.start',

  HARNESS_PATCH_REPORT: 'harness.patch_report',
  HARNESS_THROTTLE: 'harness.throttle',
  HARNESS_ERROR: 'harness.error',

  TIMER_SCHEDULE: 'timer.schedule',
  TIMER_FIRE: 'timer.fire',
  TIMER_CLEAR: 'timer.clear',

  OBSERVER_CREATE: 'observer.create',
  OBSERVER_OBSERVE: 'observer.observe',
  OBSERVER_STOP: 'observer.stop',
  OBSERVER_FIRE: 'observer.fire',

  NET_REQUEST: 'net.request',
  NET_RESPONSE: 'net.response',

  MEDIA_ELEMENT_SEEN: 'media.element_seen',
  MEDIA_PLAY: 'media.play',
  MEDIA_STATE: 'media.state',

  DOM_TEXT_WRITE: 'dom.text_write',
  DOM_MUTATION_DIGEST: 'dom.mutation_digest',

  KILL_ARMED: 'kill.armed',
  KILL_DISARMED: 'kill.disarmed',
  KILL_AUTO_DISARMED: 'kill.auto_disarmed',
  KILL_SUPPRESSED: 'kill.suppressed'
});

/** `cause.type` values. EVENTS.md §"`cause` — what was running". */
export const CAUSE = Object.freeze({
  TIMER: 'timer',
  OBSERVER: 'observer',
  EVENT: 'event'
});

/**
 * EVENTS.md: "Treat `age_ms <= 2` as same-task and therefore trustworthy.
 * Above that, the attribution is a guess and we do not build evidence on it."
 *
 * This constant is the honesty dial. Raising it would buy findings by lowering
 * the standard of proof, which is the one trade this project does not make.
 */
export const CAUSE_TRUST_MAX_AGE_MS = 2;

/**
 * URL schemes that are NOT the page's own shipped JavaScript.
 *
 * Guard against the worst possible bug in this product: a stack frame that
 * resolves to our own instrumentation, producing a Finding that points at
 * HOOKPRINT's code and calls it the site's. The harness self-calibrates to
 * avoid this; we refuse it a second time here because the cost of being wrong
 * is the entire credibility of the tool.
 */
const NON_PAGE_SCHEMES = ['chrome-extension:', 'moz-extension:', 'chrome:', 'about:', 'devtools:'];

function positiveInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const i = Math.trunc(value);
  return i > 0 ? i : null;
}

/**
 * Validate a raw `site` into a CallSite, or null. Never invents a line or a
 * column — an unusable frame becomes null, which becomes a `dropped` entry
 * downstream. That is the entire point.
 *
 * @param {any} raw
 * @returns {CallSite|null}
 */
export function normalizeSite(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const { file } = raw;
  if (typeof file !== 'string' || file.length === 0) return null;

  const line = positiveInt(raw.line);
  const column = positiveInt(raw.column);
  if (line === null || column === null) return null;

  const lowered = file.toLowerCase();
  if (NON_PAGE_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return null;

  return { file, line, column, fn: typeof raw.fn === 'string' ? raw.fn : null };
}

/**
 * A site is usable as CONTRACT.md evidence only if it names a real page file
 * at a real 1-indexed line and column. Called before every Finding.
 */
export function isResolvedSite(site) {
  return Boolean(
    site &&
      typeof site.file === 'string' &&
      site.file.length > 0 &&
      Number.isInteger(site.line) &&
      site.line > 0 &&
      Number.isInteger(site.column) &&
      site.column > 0 &&
      !NON_PAGE_SCHEMES.some((scheme) => site.file.toLowerCase().startsWith(scheme))
  );
}

/** The validated call site of an event, or null. */
export function siteOf(event) {
  return event ? normalizeSite(event.site) : null;
}

/**
 * EVENTS.md §"The site key": group by `` `${file}:${line}:${column}` ``. This
 * string is the identity of a piece of the page's code across the session.
 */
export function siteKey(site) {
  return isResolvedSite(site) ? `${site.file}:${site.line}:${site.column}` : null;
}

/**
 * `evidence` per CONTRACT.md is `site` minus `fn` — and minus `snippet`, which
 * `worker.js` resolves. EVENTS.md: "`{...ev.site}` minus `fn` is your evidence."
 */
export function toEvidence(site) {
  return { file: site.file, line: site.line, column: site.column };
}

/* -------------------------------------------------------------------------- */
/* Causal attribution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * True when `event` was emitted inside the given harness frame closely enough
 * to treat the attribution as fact rather than as a guess.
 *
 * This single predicate replaces the whole time-window correlation the
 * detectors used before EVENTS.md existed. A 2500 ms "it happened soon after"
 * window is a coincidence detector; a same-task causal frame is a measurement.
 *
 * @param {HookEvent} event
 * @param {"timer"|"observer"|"event"} type
 * @param {number|string} [id]  Restrict to one timer_id / observer_id.
 */
export function causedBy(event, type, id) {
  const cause = event && event.cause;
  if (!cause || cause.type !== type) return false;
  if (typeof cause.age_ms !== 'number' || cause.age_ms > CAUSE_TRUST_MAX_AGE_MS) return false;
  if (id !== undefined && cause.id !== id) return false;
  return true;
}

/**
 * Whether this event is attributable to a real user gesture.
 *
 * ⚠️ HARNESS v1 GAP — read before using this.
 *
 * EVENTS.md lists `"event"` as a legal `cause.type` and instructs detectors to
 * count `user_confirmations` from causal frames carrying it. `instrument.js`
 * v1 does not patch `addEventListener`, and only ever pushes `"timer"` and
 * `"observer"` frames onto its cause stack, so no event with
 * `cause.type === "event"` can be produced. The predicate is written against
 * the contract rather than against the current implementation so that it
 * starts working the moment the harness emits one — and so that the absence is
 * visible here rather than assumed away at every call site.
 *
 * `gestureSignalAvailable(events)` below is what a detector must ask before
 * reporting a *number* for user confirmations.
 */
export function isUserInitiated(event) {
  return causedBy(event, CAUSE.EVENT);
}

/**
 * True only if this event stream could carry a user-gesture attribution at all.
 *
 * A detector that cannot answer "did the user ask for this?" must not print a
 * zero and let a reader take it for a measurement. CONTRACT.md's `observed`
 * field is "what was *measured happening*" — an unmeasurable quantity is
 * omitted, not defaulted.
 */
export function gestureSignalAvailable(events) {
  return events.some((e) => e && e.cause && e.cause.type === CAUSE.EVENT);
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * True for a structurally valid v1 event. EVENTS.md: "Every event, without
 * exception, has exactly these six keys" and "Refuse anything else loudly" for
 * a version mismatch.
 */
export function isValidEvent(raw) {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      raw.v === SCHEMA_VERSION &&
      Number.isFinite(raw.seq) &&
      Number.isFinite(raw.t) &&
      typeof raw.type === 'string' &&
      raw.type.length > 0 &&
      raw.data !== null &&
      typeof raw.data === 'object'
  );
}

/**
 * Anything present in the stream carrying a schema version we do not
 * understand. Surfaced by `runDetectors` rather than dropped in silence: a
 * version skew between the harness and the detectors is the kind of failure
 * that otherwise presents as "the site is clean".
 */
export function foreignVersions(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];
  const seen = new Set();
  for (const raw of rawEvents) {
    if (raw && typeof raw === 'object' && 'v' in raw && raw.v !== SCHEMA_VERSION) seen.add(raw.v);
  }
  return [...seen];
}

/**
 * Validate and order an event array.
 *
 * EVENTS.md §"Ordering": "`seq` is strictly increasing and totally orders
 * everything. **Sort by it, not by `t`.**" `t` is a float that can tie; `seq`
 * cannot. Ties on `seq` (which the contract forbids but a replayed fixture can
 * still produce) fall back to `t` for a deterministic order.
 *
 * @param {Array<Object>} rawEvents
 * @returns {HookEvent[]}
 */
export function normalizeEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];
  const out = rawEvents.filter(isValidEvent);
  out.sort((a, b) => a.seq - b.seq || a.t - b.t);
  return out;
}
