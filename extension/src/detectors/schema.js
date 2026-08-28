/**
 * HOOKPRINT — detector event schema.
 *
 * ============================================================================
 * THIS FILE IS THE ENTIRE COUPLING SURFACE BETWEEN THE DETECTORS AND THE
 * INSTRUMENTATION HARNESS (`instrument.js` / `bridge.js`, owned by edith).
 * ============================================================================
 *
 * The detectors were written before `EVENTS.md` existed. Rather than guess and
 * scatter the guess across five modules, every assumption about the harness's
 * output lives here, and every detector consumes only the normalised shape
 * below. Reconciling with the real schema is a mechanical edit to the two alias
 * tables in this file. No detector logic changes.
 *
 * ---------------------------------------------------------------------------
 * ASSUMED RAW EVENT (what the harness is assumed to hand us)
 * ---------------------------------------------------------------------------
 *
 *   {
 *     type: "media_play",              // string, see EVENT_TYPES below
 *     t:    1234.5,                    // ms, monotonic within one scan
 *     site: {                          // resolved page call site, or null
 *       file:    "https://x.com/app.js",
 *       line:    4412,
 *       column:  18,
 *       snippet: "video.play();"
 *     },
 *     data: { ... }                    // per-type payload, see EVENT_TYPES
 *   }
 *
 * `site` being null is normal and expected — a stack frame that could not be
 * resolved to the page's own code. Per CONTRACT.md rule 1 that is precisely
 * what sends a candidate to `dropped` instead of `findings`.
 *
 * Field aliases are tolerated (`ts`/`time`/`timestamp` for `t`,
 * `callSite`/`frame`/`evidence` for `site`, `url`/`fileName` for `file`, …) so
 * that a near-miss on naming does not silently produce zero findings.
 */

/**
 * @typedef {Object} CallSite
 * @property {string} file    Full URL of the JS file.
 * @property {number} line    1-indexed.
 * @property {number} column  1-indexed.
 * @property {string} snippet Actual source text at that location.
 */

/**
 * @typedef {Object} HookEvent
 * @property {string}         type
 * @property {number}         t
 * @property {CallSite|null}  site
 * @property {Object}         data
 */

/**
 * The event vocabulary the detectors consume.
 *
 * | type              | data fields                                          |
 * |-------------------|------------------------------------------------------|
 * | user_gesture      | kind: click|keydown|pointerdown|touchstart|submit|wheel|scroll
 * | observer_register | observerId, rootMargin?                              |
 * | observer_fire     | observerId, isIntersecting, ratio?                   |
 * | listener_add      | event: "scroll"|…, target?                           |
 * | listener_fire     | event: "scroll"|…                                    |
 * | net_request       | url, method?, api: "fetch"|"xhr"                     |
 * | dom_append        | nodeCount?, parent?                                  |
 * | dom_text          | target (stable id/selector), value (string written)   |
 * | media_play        | media?, tag?, muted?, hasAutoplayAttr?, viaTimer?    |
 * | timer_set         | timerId?, kind: "interval"|"timeout", delay          |
 * | timer_fire        | timerId?, kind: "interval"|"timeout"                 |
 */
export const EVENT_TYPES = Object.freeze({
  USER_GESTURE: 'user_gesture',
  OBSERVER_REGISTER: 'observer_register',
  OBSERVER_FIRE: 'observer_fire',
  LISTENER_ADD: 'listener_add',
  LISTENER_FIRE: 'listener_fire',
  NET_REQUEST: 'net_request',
  DOM_APPEND: 'dom_append',
  DOM_TEXT: 'dom_text',
  MEDIA_PLAY: 'media_play',
  TIMER_SET: 'timer_set',
  TIMER_FIRE: 'timer_fire'
});

/**
 * ALIAS TABLE 1 of 2 — event type names.
 * When EVENTS.md lands, add whatever edith actually emits on the left.
 */
const TYPE_ALIASES = Object.freeze({
  // user gestures
  gesture: EVENT_TYPES.USER_GESTURE,
  user_event: EVENT_TYPES.USER_GESTURE,
  input: EVENT_TYPES.USER_GESTURE,

  // IntersectionObserver
  io_register: EVENT_TYPES.OBSERVER_REGISTER,
  io_observe: EVENT_TYPES.OBSERVER_REGISTER,
  intersection_observe: EVENT_TYPES.OBSERVER_REGISTER,
  observer_observe: EVENT_TYPES.OBSERVER_REGISTER,
  io_callback: EVENT_TYPES.OBSERVER_FIRE,
  intersection: EVENT_TYPES.OBSERVER_FIRE,
  observer_callback: EVENT_TYPES.OBSERVER_FIRE,

  // addEventListener
  listener_register: EVENT_TYPES.LISTENER_ADD,
  add_event_listener: EVENT_TYPES.LISTENER_ADD,
  listener_callback: EVENT_TYPES.LISTENER_FIRE,
  handler_fire: EVENT_TYPES.LISTENER_FIRE,

  // network
  fetch: EVENT_TYPES.NET_REQUEST,
  xhr: EVENT_TYPES.NET_REQUEST,
  request: EVENT_TYPES.NET_REQUEST,
  network: EVENT_TYPES.NET_REQUEST,

  // DOM
  append_child: EVENT_TYPES.DOM_APPEND,
  dom_insert: EVENT_TYPES.DOM_APPEND,
  mutation_append: EVENT_TYPES.DOM_APPEND,
  text_content_set: EVENT_TYPES.DOM_TEXT,
  dom_text_set: EVENT_TYPES.DOM_TEXT,
  inner_html_set: EVENT_TYPES.DOM_TEXT,

  // media
  play: EVENT_TYPES.MEDIA_PLAY,
  media_play_call: EVENT_TYPES.MEDIA_PLAY,
  video_play: EVENT_TYPES.MEDIA_PLAY,

  // timers
  set_interval: EVENT_TYPES.TIMER_SET,
  set_timeout: EVENT_TYPES.TIMER_SET,
  timer_schedule: EVENT_TYPES.TIMER_SET,
  timer_callback: EVENT_TYPES.TIMER_FIRE,
  interval_fire: EVENT_TYPES.TIMER_FIRE,
  timeout_fire: EVENT_TYPES.TIMER_FIRE
});

/** ALIAS TABLE 2 of 2 — per-field names inside a raw event. */
const TIME_KEYS = ['t', 'ts', 'time', 'timestamp', 'at'];
const SITE_KEYS = ['site', 'callSite', 'call_site', 'frame', 'evidence', 'location', 'source'];
const FILE_KEYS = ['file', 'url', 'fileName', 'filename', 'script', 'scriptUrl'];
const LINE_KEYS = ['line', 'lineNumber', 'lineno', 'row'];
const COLUMN_KEYS = ['column', 'col', 'columnNumber', 'colno'];
const SNIPPET_KEYS = ['snippet', 'source', 'text', 'code', 'sourceText'];

/**
 * URL schemes that are NOT the page's own shipped JavaScript.
 *
 * Guard against the worst possible bug in this product: a stack frame that
 * resolves to our own instrumentation, producing a Finding that points at
 * HOOKPRINT's code and calls it the site's. Better to drop the candidate.
 */
const NON_PAGE_SCHEMES = ['chrome-extension:', 'moz-extension:', 'chrome:', 'about:', 'devtools:'];

function firstPresent(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function toPositiveInt(value) {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/**
 * Normalise whatever the harness calls a call site into a CallSite, or null.
 * Never invents a line or column — an unparseable frame becomes null, which
 * becomes a `dropped` entry downstream. That is the entire point.
 */
export function normalizeSite(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const file = firstPresent(raw, FILE_KEYS);
  const line = toPositiveInt(firstPresent(raw, LINE_KEYS));
  const column = toPositiveInt(firstPresent(raw, COLUMN_KEYS));

  if (typeof file !== 'string' || file.length === 0) return null;
  if (line === null || column === null) return null;

  const lowered = file.toLowerCase();
  if (NON_PAGE_SCHEMES.some((scheme) => lowered.startsWith(scheme))) return null;

  const snippet = firstPresent(raw, SNIPPET_KEYS);
  return {
    file,
    line,
    column,
    snippet: typeof snippet === 'string' ? snippet : ''
  };
}

/**
 * A site is usable as CONTRACT.md evidence only if it has a real file, a real
 * 1-indexed line and a real 1-indexed column. Called before every Finding.
 */
export function isResolvedSite(site) {
  return Boolean(
    site &&
      typeof site.file === 'string' &&
      site.file.length > 0 &&
      Number.isInteger(site.line) &&
      site.line > 0 &&
      Number.isInteger(site.column) &&
      site.column > 0
  );
}

/** Stable key for grouping events that share one call site. */
export function siteKey(site) {
  return isResolvedSite(site) ? `${site.file}:${site.line}:${site.column}` : null;
}

/**
 * Normalise one raw harness event. Returns null for anything unrecognisable
 * rather than fabricating a shape.
 *
 * @param {Object} raw
 * @returns {HookEvent|null}
 */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const rawType = raw.type ?? raw.kind ?? raw.name;
  if (typeof rawType !== 'string' || rawType.length === 0) return null;

  const type = TYPE_ALIASES[rawType] ?? rawType;

  const t = Number(firstPresent(raw, TIME_KEYS));
  if (!Number.isFinite(t)) return null;

  const siteSource = firstPresent(raw, SITE_KEYS);
  const site = normalizeSite(siteSource) ?? normalizeSite(raw);

  // `data` may be nested or flattened onto the event; accept both.
  const data = raw.data && typeof raw.data === 'object' ? { ...raw.data } : {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'type' || k === 'data' || TIME_KEYS.includes(k) || SITE_KEYS.includes(k)) continue;
    if (!(k in data)) data[k] = v;
  }

  return { type, t, site, data };
}

/**
 * Normalise and time-order an event array. Detectors assume ascending `t`;
 * the harness posts across a message boundary and ordering is not guaranteed.
 *
 * @param {Array<Object>} rawEvents
 * @returns {HookEvent[]}
 */
export function normalizeEvents(rawEvents) {
  if (!Array.isArray(rawEvents)) return [];
  const out = [];
  for (const raw of rawEvents) {
    const ev = normalizeEvent(raw);
    if (ev) out.push(ev);
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * A *confirmation* is a deliberate user act that authorises what follows.
 *
 * Scrolling and wheeling are deliberately NOT confirmations. Scrolling is the
 * very input infinite scroll consumes; treating it as consent would make the
 * mechanic undetectable by definition. CONTRACT.md's own example metric is
 * "user_confirmations", not "user_interactions" — this is that distinction.
 */
export const CONFIRMATION_KINDS = Object.freeze([
  'click',
  'pointerdown',
  'mousedown',
  'keydown',
  'keypress',
  'touchstart',
  'touchend',
  'submit',
  'change'
]);

export function isConfirmation(event) {
  if (!event || event.type !== EVENT_TYPES.USER_GESTURE) return false;
  const kind = event.data?.kind ?? event.data?.event ?? event.data?.name;
  // A gesture event with no kind is treated as a confirmation: the safe
  // direction is fewer findings, never more.
  if (typeof kind !== 'string') return true;
  return CONFIRMATION_KINDS.includes(kind.toLowerCase());
}
