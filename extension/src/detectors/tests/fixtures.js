/**
 * Synthetic event streams for the detector tests.
 *
 * Written against the REAL contract — `extension/src/EVENTS.md` v1, frozen —
 * not against an assumed shape. Every event here carries the full six-key
 * envelope, so a fixture is a literal example of what `instrument.js` emits
 * and a naming drift shows up as a failing test rather than as a quiet zero.
 *
 * Two properties of the harness are reproduced deliberately because detectors
 * depend on them and neither is obvious:
 *
 *  1. `instrument.js` runs the page's callback to completion and only then
 *     emits `observer.fire` / `timer.fire`. Anything the callback did
 *     therefore has a LOWER `seq` than the fire event that describes it.
 *
 *  2. Harness v1 never populates `cause` — every `emit()` call site passes an
 *     explicit `null` override, so `currentCause()` is unreachable. Fixtures
 *     default to `cause: null` to match what ships today; the `*WithCause`
 *     variants carry the field the contract describes, so the stronger path is
 *     under test and starts working the moment the harness is fixed.
 *
 * The scenarios mirror the trap pages in `testbench/` (TEAMMATE-2-TESTBENCH.md)
 * so that when the real bench lands there is a like-for-like comparison.
 */

const PAGE_JS = 'http://localhost:5501/pages/01-infinite-scroll.js';
const VIDEO_JS = 'http://localhost:5501/pages/02-autoplay.js';
const COUNTDOWN_JS = 'http://localhost:5501/pages/03-countdown.js';
const SCARCITY_JS = 'http://localhost:5501/pages/04-scarcity.js';
const CLEAN_JS = 'http://localhost:5501/pages/05-clean.js';
const FEED_JS = 'https://example.com/static/feed.js';

/** A resolvable call site. EVENTS.md: `fn` is decoration, never load-bearing. */
export function site(file, line, column, fn = null) {
  return { file, line, column, fn };
}

/** A NodeDesc, as EVENTS.md defines it. */
export function node(tag, id, path, extra = {}) {
  return {
    tag,
    id,
    cls: '',
    path,
    rect: { top: 100, height: 20, width: 780 },
    in_viewport: true,
    text_len: 0,
    ...extra
  };
}

/**
 * Builds a `seq`-ordered stream. `seq` is the total order the contract
 * guarantees, so it is assigned by push order rather than by timestamp.
 */
export function Stream(startSeq = 0) {
  const events = [];
  let seq = startSeq;
  return {
    push(type, t, callSite, data = {}, cause = null) {
      events.push({
        v: 1,
        seq: seq++,
        t,
        type,
        site: callSite ?? null,
        cause,
        data
      });
      return this;
    },
    get events() {
      return events;
    }
  };
}

/** The two events every real session opens with. */
function withSession(s, url) {
  s.push('session.start', 0.4, null, {
    session_id: 's_fixture',
    url,
    t0_epoch_ms: 1756389000123,
    referrer: '',
    visibility: 'visible'
  });
  s.push('harness.patch_report', 1.9, null, {
    install_ms: 1.42,
    installed: ['IntersectionObserver', 'MutationObserver', 'setTimeout', 'setInterval', 'fetch'],
    failed: [],
    self_file: 'chrome-extension://abc/src/instrument.js',
    document_readyState: 'loading'
  });
  return s;
}

/** A digest reporting the document getting taller. `site` is always null. */
function growthDigest(s, t, delta) {
  s.push('dom.mutation_digest', t, null, {
    window_ms: 250,
    added_nodes: 30,
    removed_nodes: 0,
    attr_changes: 2,
    text_changes: 1,
    scroll_height_before: 9400,
    scroll_height_after: 9400 + delta,
    scroll_height_delta: delta,
    top_containers: [{ node: node('div', 'feed', 'body > main > div#feed'), added: 30 }]
  });
}

/* -------------------------------------------------------------------------- */
/* Infinite scroll                                                            */
/* -------------------------------------------------------------------------- */

/**
 * IntersectionObserver on a single bottom sentinel.
 * Mirrors testbench `01-infinite-scroll.html`.
 *
 * @param {{withCause?: boolean, loads?: number, targetCount?: number}} [opts]
 */
export function infiniteScrollIntersectionObserver(opts = {}) {
  const { withCause = false, loads = 4, targetCount = 1 } = opts;
  const createSite = site(PAGE_JS, 9, 7, 'setupFeed');
  const observeSite = site(PAGE_JS, 14, 3, 'setupFeed');
  const fetchSite = site(PAGE_JS, 22, 5, 'loadMore');

  const s = Stream();
  s.push('observer.create', 100, createSite, {
    api: 'IntersectionObserver',
    observer_id: 3,
    options: { root: null, root_desc: null, rootMargin: '400px 0px', thresholds: [0] }
  });
  s.push('observer.observe', 101, observeSite, {
    api: 'IntersectionObserver',
    observer_id: 3,
    target_count: targetCount,
    target: node('div', 'scroll-sentinel', 'body > main > div#feed > div#scroll-sentinel'),
    options: null
  });

  let t = 2000;
  for (let i = 0; i < loads; i += 1) {
    // The page's callback runs FIRST — its request gets the lower seq.
    s.push(
      'net.request',
      t,
      fetchSite,
      {
        api: 'fetch',
        request_id: i + 1,
        method: 'GET',
        url: `https://example.com/api/feed?cursor=${i}`,
        same_origin: true,
        open_site: null,
        body_len: 0
      },
      withCause ? { type: 'observer', id: 3, age_ms: 0 } : null
    );
    s.push('observer.fire', t + 0.4, createSite, {
      api: 'IntersectionObserver',
      observer_id: 3,
      fire_count: i + 1,
      duration_ms: 0.9,
      entry_count: 1,
      entries: [
        {
          target: node('div', 'scroll-sentinel', 'body > main > div#feed > div#scroll-sentinel'),
          isIntersecting: true,
          intersectionRatio: 1,
          boundingTop: 712
        }
      ]
    });
    s.push('net.response', t + 180, fetchSite, {
      request_id: i + 1,
      api: 'fetch',
      status: 200,
      ok: true,
      duration_ms: 180,
      bytes: 41822,
      content_type: 'application/json',
      error: null
    });
    growthDigest(s, t + 250, 4700);
    t += 3000;
  }
  return s.events;
}

/**
 * A lazy-image loader: the same API, the same fetches, watching 200 nodes.
 * EVENTS.md calls `target_count` the distinction "that stops us calling every
 * IntersectionObserver infinite scroll", so this must produce nothing.
 */
export function lazyImageObserver() {
  const createSite = site(CLEAN_JS, 70, 3, 'initLazyImages');
  const observeSite = site(CLEAN_JS, 74, 5, 'initLazyImages');
  const fetchSite = site(CLEAN_JS, 78, 7, 'loadImage');

  const s = Stream();
  s.push('observer.create', 200, createSite, {
    api: 'IntersectionObserver',
    observer_id: 9,
    options: { root: null, root_desc: null, rootMargin: '0px', thresholds: [0.1] }
  });
  s.push('observer.observe', 205, observeSite, {
    api: 'IntersectionObserver',
    observer_id: 9,
    target_count: 200,
    target: node('img', '', 'body > main > ul.grid > li > img'),
    options: null
  });

  let t = 3000;
  for (let i = 0; i < 6; i += 1) {
    s.push('net.request', t, fetchSite, {
      api: 'fetch',
      request_id: 500 + i,
      method: 'GET',
      url: `https://cdn.example.com/img/${i}.webp`,
      same_origin: false,
      open_site: null,
      body_len: 0
    });
    s.push('observer.fire', t + 0.3, createSite, {
      api: 'IntersectionObserver',
      observer_id: 9,
      fire_count: i + 1,
      duration_ms: 0.4,
      entry_count: 1,
      entries: [
        {
          target: node('img', '', 'body > main > ul.grid > li > img'),
          isIntersecting: true,
          intersectionRatio: 0.4,
          boundingTop: 620
        }
      ]
    });
    // Images replace placeholders of the same size: the page does not grow.
    s.push('dom.mutation_digest', t + 260, null, {
      window_ms: 250,
      added_nodes: 1,
      removed_nodes: 1,
      attr_changes: 3,
      text_changes: 0,
      scroll_height_before: 9400,
      scroll_height_after: 9400,
      scroll_height_delta: 0,
      top_containers: []
    });
    t += 2000;
  }
  return s.events;
}

/**
 * The same fetch-and-append, every load behind a click. Honest pagination.
 *
 * Under harness v1 the click itself is invisible — `addEventListener` is not
 * patched. What distinguishes this from infinite scroll is that no
 * IntersectionObserver is involved at all, so no chain can form.
 */
export function clickToLoadPagination() {
  const fetchSite = site(CLEAN_JS, 18, 5, 'nextPage');

  const s = Stream();
  let t = 4000;
  for (let i = 0; i < 3; i += 1) {
    s.push('net.request', t, fetchSite, {
      api: 'fetch',
      request_id: 100 + i,
      method: 'GET',
      url: `https://example.com/api/page?n=${i + 2}`,
      same_origin: true,
      open_site: null,
      body_len: 0
    });
    s.push('net.response', t + 120, fetchSite, {
      request_id: 100 + i,
      api: 'fetch',
      status: 200,
      ok: true,
      duration_ms: 120,
      bytes: 8000,
      content_type: 'application/json',
      error: null
    });
    growthDigest(s, t + 250, 3200);
    t += 6000;
  }
  return s.events;
}

/**
 * Infinite scroll implemented with a scroll listener and no
 * IntersectionObserver — the shape harness v1 cannot see, because
 * `addEventListener` is not patched and there is no gesture signal to tell it
 * apart from `clickToLoadPagination` above. Pinned as a known blind spot.
 */
export function scrollListenerInfiniteScroll() {
  const fetchSite = site(FEED_JS, 47, 5, 'onScroll');

  const s = Stream();
  let t = 2000;
  for (let i = 0; i < 5; i += 1) {
    s.push('net.request', t, fetchSite, {
      api: 'fetch',
      request_id: 300 + i,
      method: 'GET',
      url: '/feed/more',
      same_origin: true,
      open_site: null,
      body_len: 0
    });
    growthDigest(s, t + 250, 5100);
    t += 4000;
  }
  return s.events;
}

/* -------------------------------------------------------------------------- */
/* Autoplay                                                                   */
/* -------------------------------------------------------------------------- */

/** Mirrors testbench `02-autoplay.html` — setTimeout, then .play(). */
export function autoplayViaTimer(opts = {}) {
  const { withCause = false } = opts;
  const setSite = site(VIDEO_JS, 7, 1, 'init');
  const playSite = site(VIDEO_JS, 12, 3, 'startVideo');

  const s = Stream();
  s.push('timer.schedule', 120, setSite, {
    api: 'setTimeout',
    timer_id: 1,
    delay_ms: 4500,
    repeating: false,
    has_fn: true,
    arg_count: 2
  });
  s.push(
    'media.play',
    4620,
    playSite,
    {
      media_id: 1,
      tag: 'video',
      paused_before: true,
      muted: false,
      current_time: 0,
      duration: 31.4,
      autoplay_attr: false,
      readyState: 4,
      in_viewport: true,
      user_activation: { is_active: false, has_been_active: false }
    },
    withCause ? { type: 'timer', id: 1, age_ms: 0 } : null
  );
  s.push('timer.fire', 4621, setSite, {
    api: 'setTimeout',
    timer_id: 1,
    delay_ms: 4500,
    iteration: 1,
    scheduled_at: 120,
    actual_gap_ms: 4501,
    drift_ms: 1,
    duration_ms: 0.6
  });
  s.push('media.state', 4700, playSite, {
    media_id: 1,
    state: 'playing',
    current_time: 0.04,
    muted: false,
    played_ms: 0
  });
  return s.events;
}

/** The user pressed play. `is_active: true` — not a finding. */
export function userInitiatedPlay() {
  const playSite = site(VIDEO_JS, 30, 5, 'onPlayClick');
  const s = Stream();
  s.push('media.play', 5030, playSite, {
    media_id: 2,
    tag: 'video',
    paused_before: true,
    muted: false,
    current_time: 0,
    duration: 12,
    autoplay_attr: false,
    readyState: 4,
    in_viewport: true,
    user_activation: { is_active: true, has_been_active: true }
  });
  s.push('media.state', 5100, playSite, {
    media_id: 2,
    state: 'playing',
    current_time: 0.02,
    muted: false,
    played_ms: 0
  });
  return s.events;
}

/** Autoplay via the HTML attribute. Real mechanic, no line of code to name. */
export function autoplayAttributeOnly() {
  const s = Stream();
  s.push('media.element_seen', 300, null, {
    media_id: 5,
    tag: 'video',
    autoplay_attr: true,
    muted: true,
    loop: true,
    preload: 'auto',
    src: 'https://x.com/v/clip.mp4',
    node: node('video', 'hero', 'body > section#hero > video#hero')
  });
  s.push('media.state', 420, null, {
    media_id: 5,
    state: 'playing',
    current_time: 0.03,
    muted: true,
    played_ms: 0
  });
  return s.events;
}

/**
 * The page called play() with no activation and the browser refused.
 * EVENTS.md: "that is not our finding to claim."
 */
export function autoplayRejectedByBrowser() {
  const playSite = site(VIDEO_JS, 44, 3, 'tryAutostart');
  const s = Stream();
  s.push('media.play', 800, playSite, {
    media_id: 7,
    tag: 'video',
    paused_before: true,
    muted: false,
    current_time: 0,
    duration: 20,
    autoplay_attr: false,
    readyState: 4,
    in_viewport: true,
    user_activation: { is_active: false, has_been_active: false }
  });
  s.push('media.state', 830, playSite, {
    media_id: 7,
    state: 'play_rejected',
    current_time: 0,
    muted: false,
    played_ms: 0,
    error: 'NotAllowedError'
  });
  return s.events;
}

/** The browser did not expose navigator.userActivation. Unknown, not false. */
export function autoplayActivationUnknown() {
  const playSite = site(VIDEO_JS, 50, 3, 'startVideo');
  const s = Stream();
  s.push('media.play', 900, playSite, {
    media_id: 8,
    tag: 'video',
    paused_before: true,
    muted: false,
    current_time: 0,
    duration: 20,
    autoplay_attr: false,
    readyState: 4,
    in_viewport: true,
    user_activation: { is_active: null, has_been_active: null }
  });
  s.push('media.state', 960, playSite, {
    media_id: 8,
    state: 'playing',
    current_time: 0.01,
    muted: false,
    played_ms: 0
  });
  return s.events;
}

/* -------------------------------------------------------------------------- */
/* Countdown                                                                  */
/* -------------------------------------------------------------------------- */

function mmss(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `Offer ends in ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * A timer-driven text display. Shared by the countdown and the negative
 * controls so they differ only in the numbers and the cadence.
 */
function tickingDisplay({ scheduleSite, writeSite, timerId, delayMs, values, format, nodeDesc, withCause }) {
  const s = Stream();
  s.push('timer.schedule', 150, scheduleSite, {
    api: 'setInterval',
    timer_id: timerId,
    delay_ms: delayMs,
    repeating: true,
    has_fn: true,
    arg_count: 2
  });

  let t = 150 + delayMs;
  values.forEach((value, i) => {
    s.push(
      'dom.text_write',
      t,
      writeSite,
      {
        prop: 'textContent',
        value: format(value),
        value_len: format(value).length,
        truncated: false,
        write_count: i + 1,
        node: nodeDesc
      },
      withCause ? { type: 'timer', id: timerId, age_ms: 0 } : null
    );
    s.push('timer.fire', t + 0.2, scheduleSite, {
      api: 'setInterval',
      timer_id: timerId,
      delay_ms: delayMs,
      iteration: i + 1,
      scheduled_at: 150,
      actual_gap_ms: delayMs + 2,
      drift_ms: 2,
      duration_ms: 0.3
    });
    t += delayMs;
  });
  return s.events;
}

/**
 * Mirrors testbench `03-countdown.html`: counts to zero, then silently
 * restarts. Shortened to a 9-second cycle so the fixture stays readable.
 */
export function countdownWithReset(opts = {}) {
  return tickingDisplay({
    scheduleSite: site(COUNTDOWN_JS, 11, 1, 'init'),
    writeSite: site(COUNTDOWN_JS, 16, 3, 'tick'),
    timerId: 7,
    delayMs: 1000,
    values: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8, 7],
    format: mmss,
    nodeDesc: node('span', 'countdown', 'body > div.banner > span#countdown'),
    withCause: opts.withCause === true
  });
}

/** Counts to zero and stays there. A real deadline. Reported, lower confidence. */
export function countdownNoReset() {
  return tickingDisplay({
    scheduleSite: site(COUNTDOWN_JS, 11, 1, 'init'),
    writeSite: site(COUNTDOWN_JS, 16, 3, 'tick'),
    timerId: 7,
    delayMs: 1000,
    values: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
    format: mmss,
    nodeDesc: node('span', 'countdown', 'body > div.banner > span#countdown'),
    withCause: false
  });
}

/**
 * Mirrors testbench `04-scarcity.html` — "Only 3 left in stock!" decrementing
 * every 25 seconds. Timer-driven and decrementing, but NOT a countdown timer.
 */
export function scarcityStockTicker() {
  return tickingDisplay({
    scheduleSite: site(SCARCITY_JS, 8, 1, 'init'),
    writeSite: site(SCARCITY_JS, 13, 3, 'dropStock'),
    timerId: 3,
    delayMs: 25000,
    values: [5, 4, 3, 2, 1],
    format: (v) => `Only ${v} left in stock!`,
    nodeDesc: node('span', 'stock', 'body > div.buybox > span#stock'),
    withCause: false
  });
}

/** A clock ticking UP. Timer-driven display, not a countdown. */
export function elapsedTimeCounter() {
  return tickingDisplay({
    scheduleSite: site(CLEAN_JS, 40, 1, 'init'),
    writeSite: site(CLEAN_JS, 44, 3, 'tick'),
    timerId: 9,
    delayMs: 1000,
    values: [1, 2, 3, 4, 5, 6, 7, 8],
    format: (v) => `00:0${v}`,
    nodeDesc: node('span', 'elapsed', 'body > footer > span#elapsed'),
    withCause: false
  });
}

/* -------------------------------------------------------------------------- */
/* Interval dispersion                                                        */
/* -------------------------------------------------------------------------- */

function requestSeries(times, url, callSite, startSeq = 0) {
  const s = Stream(startSeq);
  times.forEach((t, i) => {
    s.push('net.request', t, callSite, {
      api: 'fetch',
      request_id: i + 1,
      method: 'GET',
      url: typeof url === 'function' ? url(i) : url,
      same_origin: true,
      open_site: null,
      body_len: 0
    });
  });
  return s.events;
}

const DISPERSED = [0, 1200, 9000, 11500, 26000, 28100, 45000, 60500, 62000, 78000];

/** Widely dispersed refetch gaps from one call site. */
export function variableIntervalRefetch() {
  return requestSeries(
    DISPERSED,
    (i) => `https://example.com/api/feed?cursor=${i}`,
    site(FEED_JS, 22, 9, 'scheduleRefresh')
  );
}

/**
 * The signal EVENTS.md actually names: a self-rescheduling `setTimeout` chain
 * whose requested `delay_ms` varies, measured at the schedule site.
 */
export function selfReschedulingChain() {
  const scheduleSite = site(FEED_JS, 31, 5, 'scheduleRefresh');
  const delays = [1200, 7800, 2500, 14500, 2100, 16900, 15500, 1500, 16000];

  const s = Stream();
  let t = 500;
  delays.forEach((delay, i) => {
    s.push('timer.schedule', t, scheduleSite, {
      api: 'setTimeout',
      timer_id: 40 + i,
      delay_ms: delay,
      repeating: false,
      has_fn: true,
      arg_count: 1
    });
    t += delay;
    s.push('timer.fire', t, scheduleSite, {
      api: 'setTimeout',
      timer_id: 40 + i,
      delay_ms: delay,
      iteration: 1,
      scheduled_at: t - delay,
      actual_gap_ms: delay + 1,
      drift_ms: 1,
      duration_ms: 0.4
    });
  });
  return s.events;
}

/** A fixed 5-second poll. Ordinary engineering. Must produce nothing. */
export function fixedIntervalPolling() {
  return requestSeries(
    [0, 5000, 10000, 15000, 20000, 25000, 30000],
    'https://example.com/api/notifications',
    site(FEED_JS, 88, 5, 'poll')
  );
}

/**
 * A fixed 5-second poll with one long gap in the middle — a backgrounded tab.
 * Coefficient of variation alone calls this variable. It is not. This is the
 * fixture that tests whether the statistic is computed honestly.
 */
export function fixedIntervalWithOneStall() {
  return requestSeries(
    [0, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 125000, 130000, 135000, 140000],
    'https://example.com/api/notifications',
    site(FEED_JS, 88, 5, 'poll')
  );
}

/**
 * Dispersed gaps, but the frames never resolved. Must be dropped, not reported.
 * A different endpoint from `variableIntervalRefetch` on purpose, so the two
 * can be combined in one stream without merging into a single series.
 */
export function variableIntervalUnresolvable() {
  return requestSeries(DISPERSED, (i) => `https://example.com/api/suggestions?cursor=${i}`, null);
}

/**
 * One refetch that issues three parallel requests each time. Real sites do
 * this constantly. Naively, two-thirds of the gaps are zero and the median
 * gap is zero, which silently kills the statistic — the burst must be
 * collapsed to one refetch before the intervals are measured.
 */
export function variableIntervalWithParallelBursts() {
  const callSite = site(FEED_JS, 22, 9, 'scheduleRefresh');
  const s = Stream();
  let id = 1;
  for (const t of DISPERSED) {
    for (let k = 0; k < 3; k += 1) {
      s.push('net.request', t + k * 4, callSite, {
        api: 'fetch',
        request_id: id++,
        method: 'GET',
        url: `https://example.com/api/feed?shard=${k}`,
        same_origin: true,
        open_site: null,
        body_len: 0
      });
    }
  }
  return s.events;
}

/* -------------------------------------------------------------------------- */
/* The control                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The hard negative. Mirrors testbench `05-clean.html`, but deliberately
 * harder than a blank page — it contains every ingredient of a positive
 * except the thing that makes it one:
 *
 *   - a lazy-image `IntersectionObserver` watching 200 nodes, firing and
 *     fetching, which is the exact API infinite scroll uses
 *   - real pagination: fetch and append with genuine `scroll_height` growth,
 *     every time behind a click the harness cannot see
 *   - a fixed-interval analytics beacon that sometimes lands moments after a
 *     content load, which is the shape of an infinite-scroll pair
 *   - a `<video>` the user presses play on
 *   - a timer-driven display that counts up, not down
 *
 * Any finding on this stream is a false positive.
 */
export function cleanControlPage() {
  const beaconSite = site(CLEAN_JS, 60, 1, 'init');

  const events = [
    ...withSession(Stream(), 'http://localhost:5501/pages/05-clean.html').events,
    ...lazyImageObserver(),
    ...clickToLoadPagination(),
    ...userInitiatedPlay(),
    ...elapsedTimeCounter(),
    ...requestSeries(
      [30000, 60000, 90000, 120000, 150000, 180000],
      'https://analytics.example.com/collect',
      beaconSite
    )
  ];

  // Re-key `seq` so the merged stream carries one strictly increasing order,
  // exactly as the harness would have produced it.
  events.sort((a, b) => a.t - b.t);
  events.forEach((e, i) => {
    e.seq = i;
  });
  return events;
}

/** Absolutely nothing happened. */
export function emptyStream() {
  return [];
}

/** A stream from a harness speaking a schema these detectors do not read. */
export function futureSchemaStream() {
  return infiniteScrollIntersectionObserver().map((e) => ({ ...e, v: 2 }));
}
