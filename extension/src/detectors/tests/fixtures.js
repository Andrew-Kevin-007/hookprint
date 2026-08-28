/**
 * Synthetic event streams for the detector tests.
 *
 * These are hand-built against the assumed schema in `../schema.js`, NOT
 * captured from the harness. That is deliberate: the detectors have to be
 * fully testable before `instrument.js` exists, and the negative cases have to
 * be constructible on demand rather than waiting for a page that happens to be
 * clean.
 *
 * The scenarios mirror the trap pages in `testbench/` (TEAMMATE-2-TESTBENCH.md)
 * so that when the real bench lands there is a like-for-like comparison.
 */

/** A resolvable call site — page JavaScript, real line, real column. */
export function site(file, line, column, snippet) {
  return { file, line, column, snippet };
}

export function ev(type, t, callSite, data = {}) {
  return { type, t, site: callSite ?? null, data };
}

const PAGE_JS = 'http://localhost:5501/pages/01-infinite-scroll.js';
const VIDEO_JS = 'http://localhost:5501/pages/02-autoplay.js';
const COUNTDOWN_JS = 'http://localhost:5501/pages/03-countdown.js';
const SCARCITY_JS = 'http://localhost:5501/pages/04-scarcity.js';
const CLEAN_JS = 'http://localhost:5501/pages/05-clean.js';
const FEED_JS = 'https://example.com/static/feed.js';

/* -------------------------------------------------------------------------- */
/* Infinite scroll                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Implementation A — IntersectionObserver on a bottom sentinel.
 * Mirrors testbench `01-infinite-scroll.html`.
 */
export function infiniteScrollIntersectionObserver() {
  const registerSite = site(PAGE_JS, 14, 3, 'observer.observe(sentinel);');
  const callbackSite = site(PAGE_JS, 9, 7, 'if (entries[0].isIntersecting) loadMore();');
  const appendSite = site(PAGE_JS, 22, 5, 'list.appendChild(frag);');

  const events = [ev('observer_register', 100, registerSite, { observerId: 'io_1', rootMargin: '200px' })];

  let t = 2000;
  for (let i = 0; i < 4; i += 1) {
    events.push(ev('observer_fire', t, callbackSite, { observerId: 'io_1', isIntersecting: true, ratio: 1 }));
    events.push(ev('net_request', t + 50, callbackSite, { url: '/api/items?page=' + (i + 2), api: 'fetch' }));
    events.push(ev('dom_append', t + 200, appendSite, { nodeCount: 20 }));
    t += 3000;
  }
  return events;
}

/**
 * Implementation B — plain scroll listener measuring document height.
 * No IntersectionObserver anywhere in this stream. Same mechanic.
 */
export function infiniteScrollScrollListener() {
  const addSite = site(FEED_JS, 41, 1, "window.addEventListener('scroll', onScroll);");
  const handlerSite = site(FEED_JS, 47, 5, 'if (nearBottom()) fetchNextPage();');
  const appendSite = site(FEED_JS, 58, 3, 'feed.insertAdjacentHTML("beforeend", html);');

  const events = [ev('listener_add', 80, addSite, { event: 'scroll', target: 'window' })];

  let t = 2000;
  for (let i = 0; i < 4; i += 1) {
    // A real scroll gesture fires the handler many times in quick succession.
    events.push(ev('listener_fire', t, handlerSite, { event: 'scroll' }));
    events.push(ev('listener_fire', t + 40, handlerSite, { event: 'scroll' }));
    events.push(ev('listener_fire', t + 90, handlerSite, { event: 'scroll' }));
    events.push(ev('net_request', t + 120, handlerSite, { url: '/feed/more', api: 'fetch' }));
    events.push(ev('dom_append', t + 320, appendSite, { nodeCount: 12 }));
    t += 4000;
  }
  return events;
}

/** The same fetch-and-append, but every load is behind a click. Honest pagination. */
export function clickToLoadPagination() {
  const addSite = site(CLEAN_JS, 12, 1, "btn.addEventListener('click', nextPage);");
  const handlerSite = site(CLEAN_JS, 18, 5, 'fetchPage(current + 1);');
  const appendSite = site(CLEAN_JS, 24, 3, 'article.replaceChildren(...nodes);');

  const events = [ev('listener_add', 60, addSite, { event: 'click', target: '#next' })];

  let t = 4000;
  for (let i = 0; i < 3; i += 1) {
    // The user scrolls down to reach the button, then clicks it.
    events.push(ev('listener_fire', t - 100, handlerSite, { event: 'scroll' }));
    events.push(ev('user_gesture', t, null, { kind: 'click', target: '#next' }));
    events.push(ev('net_request', t + 50, handlerSite, { url: '/api/page?n=' + (i + 2), api: 'fetch' }));
    events.push(ev('dom_append', t + 200, appendSite, { nodeCount: 1 }));
    t += 6000;
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/* Autoplay                                                                   */
/* -------------------------------------------------------------------------- */

/** Mirrors testbench `02-autoplay.html` — setTimeout then .play(). */
export function autoplayViaTimer() {
  const setSite = site(VIDEO_JS, 7, 1, 'setTimeout(startVideo, 4500);');
  const playSite = site(VIDEO_JS, 12, 3, 'video.play();');
  return [
    ev('timer_set', 120, setSite, { timerId: 1, kind: 'timeout', delay: 4500 }),
    ev('timer_fire', 4620, setSite, { timerId: 1, kind: 'timeout' }),
    ev('media_play', 4625, playSite, { media: 'video#hero', tag: 'VIDEO', muted: false })
  ];
}

/** The user pressed play. Not a finding. */
export function userInitiatedPlay() {
  const playSite = site(VIDEO_JS, 30, 5, 'video.play();');
  return [
    ev('user_gesture', 5000, null, { kind: 'click', target: 'button.play' }),
    ev('media_play', 5030, playSite, { media: 'video#hero', tag: 'VIDEO', muted: false })
  ];
}

/** Autoplay via the HTML attribute. Real mechanic, no line of code to name. */
export function autoplayAttributeOnly() {
  return [ev('media_play', 300, null, { media: 'video#promo', tag: 'VIDEO', hasAutoplayAttr: true, muted: true })];
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
 * Mirrors testbench `03-countdown.html`: counts to zero, then silently
 * restarts. Shortened to a 9-second cycle so the fixture stays readable.
 */
export function countdownWithReset() {
  const setSite = site(COUNTDOWN_JS, 11, 1, 'setInterval(tick, 1000);');
  const writeSite = site(COUNTDOWN_JS, 16, 3, 'el.textContent = format(remaining);');

  const events = [ev('timer_set', 150, setSite, { timerId: 7, kind: 'interval', delay: 1000 })];
  const sequence = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 9, 8, 7];

  let t = 1150;
  for (const value of sequence) {
    events.push(ev('timer_fire', t - 5, setSite, { timerId: 7, kind: 'interval' }));
    events.push(ev('dom_text', t, writeSite, { target: '#countdown', value: mmss(value) }));
    t += 1000;
  }
  return events;
}

/** Counts to zero and stays there. A real deadline. Reported, lower confidence. */
export function countdownNoReset() {
  const setSite = site(COUNTDOWN_JS, 11, 1, 'setInterval(tick, 1000);');
  const writeSite = site(COUNTDOWN_JS, 16, 3, 'el.textContent = format(remaining);');

  const events = [ev('timer_set', 150, setSite, { timerId: 7, kind: 'interval', delay: 1000 })];
  let t = 1150;
  for (const value of [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) {
    events.push(ev('timer_fire', t - 5, setSite, { timerId: 7, kind: 'interval' }));
    events.push(ev('dom_text', t, writeSite, { target: '#countdown', value: mmss(value) }));
    t += 1000;
  }
  return events;
}

/**
 * Mirrors testbench `04-scarcity.html` — "Only 3 left in stock!" decrementing
 * every 25 seconds. Timer-driven and decrementing, but NOT a countdown timer.
 */
export function scarcityStockTicker() {
  const setSite = site(SCARCITY_JS, 8, 1, 'setInterval(dropStock, 25000);');
  const writeSite = site(SCARCITY_JS, 13, 3, 'label.textContent = `Only ${left} left in stock!`;');

  const events = [ev('timer_set', 90, setSite, { timerId: 3, kind: 'interval', delay: 25000 })];
  let t = 25000;
  for (const value of [5, 4, 3, 2, 1]) {
    events.push(ev('timer_fire', t - 5, setSite, { timerId: 3, kind: 'interval' }));
    events.push(ev('dom_text', t, writeSite, { target: '#stock', value: `Only ${value} left in stock!` }));
    t += 25000;
  }
  return events;
}

/** A clock ticking UP. Timer-driven display, not a countdown. */
export function elapsedTimeCounter() {
  const setSite = site(CLEAN_JS, 40, 1, 'setInterval(tick, 1000);');
  const writeSite = site(CLEAN_JS, 44, 3, 'el.textContent = elapsed;');

  const events = [ev('timer_set', 100, setSite, { timerId: 9, kind: 'interval', delay: 1000 })];
  let t = 1100;
  for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) {
    events.push(ev('timer_fire', t - 5, setSite, { timerId: 9, kind: 'interval' }));
    events.push(ev('dom_text', t, writeSite, { target: '#elapsed', value: `00:0${value}` }));
    t += 1000;
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/* Interval dispersion                                                        */
/* -------------------------------------------------------------------------- */

function requestSeries(times, url, callSite) {
  return times.map((t) => ev('net_request', t, callSite, { url, api: 'fetch' }));
}

/** Widely dispersed refetch gaps from one call site. */
export function variableIntervalRefetch() {
  const callSite = site(FEED_JS, 22, 9, 'scheduleRefresh(base + Math.random() * spread);');
  const times = [0, 1200, 9000, 11500, 26000, 28100, 45000, 60500, 62000, 78000];
  return times.map((t, i) =>
    ev('net_request', t, callSite, { url: `https://example.com/api/feed?cursor=${i}`, api: 'fetch' })
  );
}

/** A fixed 5-second poll. Ordinary engineering. Must produce nothing. */
export function fixedIntervalPolling() {
  const callSite = site(FEED_JS, 88, 5, 'setInterval(() => fetch(NOTIFICATIONS), 5000);');
  return requestSeries([0, 5000, 10000, 15000, 20000, 25000, 30000], 'https://example.com/api/notifications', callSite);
}

/**
 * A fixed 5-second poll with one long gap in the middle — a backgrounded tab.
 * Coefficient of variation alone calls this variable. It is not. This is the
 * fixture that tests whether the statistic is computed honestly.
 */
export function fixedIntervalWithOneStall() {
  const callSite = site(FEED_JS, 88, 5, 'setInterval(() => fetch(NOTIFICATIONS), 5000);');
  const times = [0, 5000, 10000, 15000, 20000, 25000, 30000, 35000, 125000, 130000, 135000, 140000];
  return requestSeries(times, 'https://example.com/api/notifications', callSite);
}

/**
 * Dispersed gaps, but the frames never resolved. Must be dropped, not reported.
 * A different endpoint from `variableIntervalRefetch` on purpose, so the two
 * can be combined in one stream without merging into a single series.
 */
export function variableIntervalUnresolvable() {
  const times = [0, 1200, 9000, 11500, 26000, 28100, 45000, 60500, 62000, 78000];
  return times.map((t, i) =>
    ev('net_request', t, null, { url: `https://example.com/api/suggestions?cursor=${i}`, api: 'fetch' })
  );
}

/**
 * One refetch that issues three parallel requests each time. Real sites do
 * this constantly. Naively, two-thirds of the gaps are zero and the median
 * gap is zero, which silently kills the statistic — the burst must be
 * collapsed to one refetch before the intervals are measured.
 */
export function variableIntervalWithParallelBursts() {
  const callSite = site(FEED_JS, 22, 9, 'scheduleRefresh(base + Math.random() * spread);');
  const times = [0, 1200, 9000, 11500, 26000, 28100, 45000, 60500, 62000, 78000];
  const events = [];
  for (const t of times) {
    for (let k = 0; k < 3; k += 1) {
      events.push(
        ev('net_request', t + k * 4, callSite, {
          url: `https://example.com/api/feed?shard=${k}`,
          api: 'fetch'
        })
      );
    }
  }
  return events;
}

/* -------------------------------------------------------------------------- */
/* The control                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The hard negative. Mirrors testbench `05-clean.html`, but deliberately
 * harder than a blank page — it contains every ingredient of a positive
 * except the thing that makes it one:
 *
 *   - a scroll listener (a sticky header), firing constantly
 *   - real pagination: fetch and append, every time behind a click
 *   - a fixed-interval analytics beacon that sometimes lands right after a
 *     scroll, which is the shape of an infinite-scroll pair
 *   - a `<video>` the user presses play on
 *   - a timer-driven display that counts up, not down
 *
 * Any finding on this stream is a false positive.
 */
export function cleanControlPage() {
  const headerSite = site(CLEAN_JS, 5, 1, "window.addEventListener('scroll', stickyHeader);");
  const headerHandler = site(CLEAN_JS, 7, 3, 'header.classList.toggle("pinned", y > 80);');
  const beaconSite = site(CLEAN_JS, 60, 1, 'setInterval(sendBeacon, 30000);');

  const events = [
    ev('listener_add', 40, headerSite, { event: 'scroll', target: 'window' }),
    ev('timer_set', 50, beaconSite, { timerId: 2, kind: 'interval', delay: 30000 })
  ];

  // Constant scrolling all session long.
  for (let t = 500; t < 200000; t += 700) {
    events.push(ev('listener_fire', t, headerHandler, { event: 'scroll' }));
  }

  // Fixed-interval analytics. Some of these land moments after a scroll event.
  for (let i = 1; i <= 6; i += 1) {
    events.push(
      ev('net_request', i * 30000, beaconSite, { url: 'https://analytics.example.com/collect', api: 'fetch' })
    );
  }

  events.push(...clickToLoadPagination());
  events.push(...userInitiatedPlay());
  events.push(...elapsedTimeCounter());

  events.sort((a, b) => a.t - b.t);
  return events;
}

/** Absolutely nothing happened. */
export function emptyStream() {
  return [];
}
