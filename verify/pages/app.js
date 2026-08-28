/*
 * HOOKPRINT — verify/pages/app.js
 *
 * THE PAGE'S OWN JAVASCRIPT. Every {file, line, column} the harness reports
 * for this page must point into THIS file. A call site naming instrument.js,
 * a chrome-extension:// URL, or an empty string is a harness failure and the
 * verification driver treats it as one.
 *
 * The page deliberately mixes mechanics that must be suppressed with mechanics
 * that must NOT be:
 *
 *   feedObserver   ONE IntersectionObserver instance doing TWO jobs — the
 *                  bottom sentinel (infinite scroll) and lazy placeholders.
 *                  Suppressing the whole observer would kill both; only
 *                  per-entry gating can kill one.
 *   progressObs    a SECOND IntersectionObserver, unrelated. Must never stop.
 *   #more          a user-confirmed load. Must still work while armed.
 *   clock          setInterval. Must still tick while armed.
 *   clip.play()    an explicit autoplay call with a real call site.
 */
(function () {
  "use strict";

  var feed = document.getElementById("feed");
  var sentinel = document.getElementById("sentinel");
  var counters = document.getElementById("counters");
  var clip = document.getElementById("clip");

  var V = window.__VERIFY__ = {
    autoLoads: 0,        // loads caused by the sentinel entering view
    buttonLoads: 0,      // loads caused by a click
    lazyHydrated: 0,     // lazy placeholders filled in by the SAME observer
    progressTicks: 0,    // fires of the unrelated second observer
    clockTicks: 0,       // setInterval
    videoPlayCalls: 0,
    videoPlaying: 0,
    videoRejected: 0,
    fetches: 0,
    errors: [],
    itemCount: 0
  };

  window.addEventListener("error", function (e) { V.errors.push("error: " + (e.message || e)); });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    V.errors.push("rejection: " + ((r && r.name) || "") + " " + ((r && r.message) || r));
  });

  function paint() {
    counters.textContent =
      "auto=" + V.autoLoads + "  button=" + V.buttonLoads + "  lazy=" + V.lazyHydrated +
      "  progress=" + V.progressTicks + "  clock=" + V.clockTicks +
      "  items=" + V.itemCount + "  fetches=" + V.fetches +
      "  video(play=" + V.videoPlayCalls + " playing=" + V.videoPlaying + " rejected=" + V.videoRejected + ")" +
      "  errors=" + V.errors.length;
  }

  /* ---- feed --------------------------------------------------------- */

  var page = 0;
  var loading = false;

  function appendItems(items) {
    for (var i = 0; i < items.length; i++) {
      var card = document.createElement("div");
      card.className = "card";
      card.innerHTML = "<b>" + items[i].title + "</b><p>" + items[i].body + "</p>";

      var ph = document.createElement("div");
      ph.className = "lazy";
      ph.dataset.lazy = "img-" + items[i].id;
      ph.textContent = "lazy " + items[i].id;
      card.appendChild(ph);

      feed.appendChild(card);
      V.itemCount++;
      feedObserver.observe(ph);            // same instance as the sentinel
    }
    paint();
  }

  function loadMore(source) {
    if (loading) return;
    loading = true;
    var p = page++;
    V.fetches++;
    fetch("/api/feed?page=" + p)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (source === "auto") V.autoLoads++; else V.buttonLoads++;
        appendItems(data.items);
        loading = false;
      })
      .catch(function (e) {
        loading = false;
        V.errors.push("feed fetch failed: " + e);
        paint();
      });
  }

  /* ---- observers ----------------------------------------------------- */

  function onFeedIntersect(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.isIntersecting) continue;
      if (e.target === sentinel) {
        // A real infinite scroll defers the load a tick, which is why the
        // harness must attribute across the setTimeout boundary.
        setTimeout(function () { loadMore("auto"); }, 60);
      } else if (e.target.dataset && e.target.dataset.lazy) {
        hydrate(e.target);
      }
    }
  }

  function hydrate(el) {
    if (el.dataset.hydrated === "1") return;
    el.dataset.hydrated = "1";
    el.textContent = "loaded " + el.dataset.lazy;
    V.lazyHydrated++;
    feedObserver.unobserve(el);
    paint();
  }

  var feedObserver = new IntersectionObserver(onFeedIntersect, { rootMargin: "150px" });

  var progressObs = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) if (entries[i].isIntersecting) V.progressTicks++;
    paint();
  }, { threshold: 0.1 });

  progressObs.observe(document.getElementById("progress-a"));
  progressObs.observe(document.getElementById("progress-b"));

  /* ---- timers -------------------------------------------------------- */

  setInterval(function () { V.clockTicks++; paint(); }, 500);

  /* ---- media --------------------------------------------------------- */

  clip.addEventListener("playing", function () { V.videoPlaying++; paint(); });

  function tryPlay() {
    V.videoPlayCalls++;
    var pr = clip.play();
    if (pr && pr.then) {
      pr.then(function () { paint(); }, function (err) {
        V.videoRejected++;
        V.errors.push("play rejected: " + (err && err.name));
        paint();
      });
    }
  }
  window.__VERIFY_PLAY__ = tryPlay;

  /* ---- wiring -------------------------------------------------------- */

  document.getElementById("more").addEventListener("click", function () { loadMore("button"); });

  setTimeout(function () {
    feedObserver.observe(sentinel);
    tryPlay();
    loadMore("auto");
  }, 100);

  paint();
})();
