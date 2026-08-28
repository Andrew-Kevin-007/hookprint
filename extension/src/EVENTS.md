# HOOKPRINT — The Event Contract

**Version `1`. Frozen. `instrument.js` produces these; detectors consume them.**

This file is to detectors what `CONTRACT.md` is to the UI. `CONTRACT.md` defines what
comes *out* of a detector (`Finding`, `Manifest`). This file defines what goes *in*.

Nobody changes a field name here without Kevin. Adding a **new event type** or a **new
optional field inside `data`** is backward-compatible and allowed; renaming or removing
anything is not.

---

## The detector interface

```js
// extension/src/detectors/index.js  — owned by cyborg, not by the harness
export function runDetectors(events, ctx) {
  return { findings: [ /* Finding, minus evidence.snippet */ ],
           dropped:  [ { proposed_mechanism, reason } ] };
}
```

| | |
|---|---|
| `events` | A flat, **`seq`-ordered** array of the event objects defined below. |
| `ctx` | `{ session_id, url, t0_epoch_ms, duration_ms, truncated }` |
| returns | `findings` are `Finding` objects per `CONTRACT.md`, **except that you leave `evidence.snippet` out**. |

**Detectors are pure.** No DOM, no `chrome.*`, no network, no clock. Same array in, same
result out — that is what makes them testable against a fixture without a browser.

**`evidence.snippet` is not yours to fill.** The MAIN world cannot read a cross-origin
script's source, so `worker.js` fetches it (extension host permissions bypass CORS),
resolves `{file,line,column}` to real source text, and writes `evidence.snippet` in
before the `Manifest` leaves. Emit `evidence` as `{ file, line, column }` and stop there.
If the worker cannot resolve a snippet, **the finding is moved to `dropped`** with reason
`"source unavailable"` — that is `CONTRACT.md` rule 1 being enforced, not a bug.

`ctx.truncated` is `true` if the session hit the event cap and you are seeing a prefix of
what happened. Say so in `observed.summary` if it changes your claim.

---

## The envelope

Every event, without exception, has exactly these six keys.

```json
{
  "v": 1,
  "seq": 412,
  "t": 3184.52,
  "type": "timer.schedule",
  "site": { "file": "https://x.com/app.js", "line": 44, "column": 12, "fn": "startCountdown" },
  "cause": { "type": "timer", "id": 17, "age_ms": 0.21 },
  "data": { }
}
```

| Key | Type | Rule |
|---|---|---|
| `v` | integer | Schema version. Always `1`. Refuse anything else loudly. |
| `seq` | integer | Monotonic from 0, per page session. **Total order.** Never reused, never reordered. Gaps mean events were throttled — see `harness.throttle`. |
| `t` | float | `performance.now()` in ms, page-relative, monotonic. Add `ctx.t0_epoch_ms` for wall clock. |
| `type` | string | One of the types below. Dotted namespace. |
| `site` | object \| `null` | The **page's own call site** — see below. `null` means we could not resolve one. |
| `cause` | object \| `null` | What the harness was executing when this happened — see below. |
| `data` | object | Type-specific. Never `null`; `{}` if empty. |

Everything is plain JSON. No DOM nodes, no functions, no cyclic references — the event has
to survive `structuredClone` twice (MAIN→ISOLATED, ISOLATED→worker) and it will not be
given the chance to fail.

### `site` — the call site

```json
{ "file": "https://x.com/static/app.4f2c.js", "line": 4412, "column": 18, "fn": "loadMore" }
```

| Field | Rule |
|---|---|
| `file` | Full URL of the page's own script. Can be `blob:`, `data:`, or the document URL for inline scripts. |
| `line` | 1-indexed. |
| `column` | 1-indexed. |
| `fn` | Function name, or `null` for an anonymous frame. Never load-bearing — decoration for the UI. |

**`site` maps one-to-one onto `CONTRACT.md`'s `evidence`.** A detector's job on the
evidence axis is to pick which event's `site` to point at; `{...ev.site}` minus `fn` is
your `evidence`.

**The site key.** Group by `` `${file}:${line}:${column}` ``. This string is the identity
of a piece of the page's code across the whole session. Repeated scheduling from one site
is the backbone of `variable_interval_refetch` and `countdown_timer`.

**`site` is never a HOOKPRINT frame.** The harness self-calibrates its own script URL at
install time and walks the stack to the first frame that is not ours, at whatever depth
that is. It is not a fixed stack index.

**`site: null` happens, and it is not a defect.** Causes, in order of how often we expect
them: the event is asynchronous with no meaningful originating frame; the site was not
symbolized under the sampling budget (`data.site_unresolved: true` marks this case
specifically); the page set `Error.stackTraceLimit = 0`; the call came from native code
or a `<anonymous>` eval frame. **Per `CONTRACT.md` rule 1, a mechanic you can only
evidence with a `null` site goes in `dropped` with a reason. Do not guess a line.**

### `cause` — what was running

```json
{ "type": "timer", "id": 17, "age_ms": 0.21 }
```

The harness maintains a stack of the page callbacks it is currently invoking. Anything
emitted while that stack is non-empty carries its top frame here. This is the causal
chain, and it is what turns a timestamp coincidence into an actual claim.

| Field | Rule |
|---|---|
| `type` | `"timer"` \| `"observer"` \| `"event"` \| `null` |
| `id` | The `timer_id` or `observer_id` of the frame that was running. |
| `age_ms` | `0` when the emit was **synchronously inside** that callback. Greater than zero when the frame had already exited — the harness is telling you how stale the attribution is. |

⚠️ **`age_ms` is the honesty dial and you must use it.** A `MutationObserver` delivers its
records as a microtask *after* the callback that caused the mutation has returned, so DOM
events carry a `cause` with a small non-zero `age_ms`. **Treat `age_ms <= 2` as
same-task and therefore trustworthy. Above that, the attribution is a guess and we do not
build evidence on it.** The harness will not lie to you about this; it does not clamp
`age_ms` to zero to look better.

`cause: null` means the call came from the page's own top-level or from a frame the
harness does not wrap.

### `NodeDesc` — how a DOM node is described

DOM nodes cannot cross `postMessage`. Wherever an event refers to an element you get this
instead:

```json
{
  "tag": "div",
  "id": "scroll-sentinel",
  "cls": "loader is-hidden",
  "path": "body > div#feed > div.list > div#scroll-sentinel",
  "rect": { "top": 9214, "height": 1, "width": 782 },
  "in_viewport": false,
  "text_len": 0
}
```

`path` is capped at 4 ancestors. `rect` is viewport-relative at the moment of capture and
may be `null` if the node was not laid out. `id`, `cls` may be `""`.

---

## Event types

21 types in 7 namespaces. Every worked example below is a complete, valid event.

### `session.start`

Always `seq: 0`. Exactly one per document.

```json
{ "v":1, "seq":0, "t":0.4, "type":"session.start", "site":null, "cause":null,
  "data": { "session_id":"s_m4x9q1c7", "url":"https://example.com/feed",
            "t0_epoch_ms":1756389000123, "referrer":"https://example.com/",
            "visibility":"visible" } }
```

### `harness.patch_report`

Emitted ~once at install. **Check this first when detection returns empty.** If
`installed` is short or `failed` is populated, the harness is the problem, not the site.

```json
{ "v":1, "seq":1, "t":1.9, "type":"harness.patch_report", "site":null, "cause":null,
  "data": { "install_ms":1.42,
            "installed":["IntersectionObserver","MutationObserver","setTimeout","setInterval",
                         "clearTimeout","clearInterval","fetch","XMLHttpRequest","HTMLMediaElement.play",
                         "Element.innerHTML","Node.textContent"],
            "failed":[], "self_file":"chrome-extension://abc.../src/instrument.js",
            "document_readyState":"loading" } }
```

`document_readyState` must be `"loading"`. Anything else means we lost the
`document_start` race and the page may have already grabbed unpatched references — an
`autoplay` miss on that page is expected, not a detector bug.

### `harness.throttle`

The harness stopped emitting some events to bound its own cost. **The counts here are
exact even though the events are gone** — use them for `observed.metrics` rather than
counting events you can see.

```json
{ "v":1, "seq":880, "t":12040.0, "type":"harness.throttle", "site":null, "cause":null,
  "data": { "entries":[
    { "reason":"site_budget", "type":"timer.schedule",
      "site_key":"https://x.com/app.js:88:9", "suppressed":1204 },
    { "reason":"resolve_budget", "type":"dom.text_write", "site_key":null, "suppressed":37 } ] } }
```

`reason` is `"site_budget"` (per-(type,site) emit cap hit), `"resolve_budget"` (event was
emitted but its `site` was left unresolved), or `"session_cap"` (global event cap hit —
`ctx.truncated` will be `true`).

### `harness.error`

A patch failed internally. The original was still called; the page was not affected.

```json
{ "v":1, "seq":93, "t":802.1, "type":"harness.error", "site":null, "cause":null,
  "data": { "where":"patch:fetch", "message":"Illegal invocation", "count":1 } }
```

### `timer.schedule`

`setTimeout` or `setInterval` was called. **`site` is the page code that scheduled it.**

```json
{ "v":1, "seq":88, "t":412.7, "type":"timer.schedule",
  "site": { "file":"https://x.com/app.js", "line":88, "column":9, "fn":"startCountdown" },
  "cause": null,
  "data": { "api":"setInterval", "timer_id":17, "delay_ms":1000,
            "repeating":true, "has_fn":true, "arg_count":2 } }
```

`has_fn: false` means the page passed a **string** to be `eval`'d; `site` still points at
the caller. `timer_id` is the real browser handle, so it joins to `timer.clear`.

### `timer.fire`

The scheduled callback actually ran. **`site` is carried over from the schedule** — so a
detector working only from fire events still has evidence binding, and the harness pays
for symbolization once instead of once per tick.

```json
{ "v":1, "seq":140, "t":1415.3, "type":"timer.fire",
  "site": { "file":"https://x.com/app.js", "line":88, "column":9, "fn":"startCountdown" },
  "cause": null,
  "data": { "api":"setInterval", "timer_id":17, "delay_ms":1000,
            "iteration":1, "scheduled_at":412.7, "actual_gap_ms":1002.6,
            "drift_ms":2.6, "duration_ms":0.31 } }
```

| Field | Meaning |
|---|---|
| `iteration` | 1-based tick count for this `timer_id`. Always `1` for `setTimeout`. |
| `actual_gap_ms` | Real elapsed since the previous fire (or since schedule, for iteration 1). |
| `drift_ms` | `actual_gap_ms - delay_ms`. Small and positive on a healthy timer. |
| `duration_ms` | How long the page's own callback took. |

> For `variable_interval_refetch`: the signal is variance in **`delay_ms` across
> `timer.schedule` events sharing one `site_key`** — a self-rescheduling `setTimeout`
> chain. It is *not* variance in `drift_ms`, which is just event-loop noise and will make
> every busy site look positive. Per `CONTRACT.md` rule 2, whatever you find is a
> behavioural signal, never proof of intent.

### `timer.clear`

```json
{ "v":1, "seq":700, "t":11418.0, "type":"timer.clear",
  "site": { "file":"https://x.com/app.js", "line":95, "column":5, "fn":"tick" },
  "cause": { "type":"timer", "id":17, "age_ms":0 },
  "data": { "api":"clearInterval", "timer_id":17, "iterations_seen":10 } }
```

A countdown that reached zero and cleared its own interval produces exactly this, with
`cause.id === data.timer_id`. That self-reference is a strong `countdown_timer` signal.

### `observer.create`

```json
{ "v":1, "seq":12, "t":210.4, "type":"observer.create",
  "site": { "file":"https://x.com/feed.js", "line":301, "column":22, "fn":"setupFeed" },
  "cause": null,
  "data": { "api":"IntersectionObserver", "observer_id":3,
            "options": { "root":null, "root_desc":null, "rootMargin":"400px 0px 400px 0px",
                         "thresholds":[0] } } }
```

For `MutationObserver`, `data.options` is `{}` — MO options arrive at `observe()`.

### `observer.observe`

**The money event for `infinite_scroll`.** `site` is where the page attached the observer.

```json
{ "v":1, "seq":13, "t":211.0, "type":"observer.observe",
  "site": { "file":"https://x.com/feed.js", "line":312, "column":14, "fn":"setupFeed" },
  "cause": null,
  "data": { "api":"IntersectionObserver", "observer_id":3, "target_count":1,
            "target": { "tag":"div", "id":"scroll-sentinel", "cls":"sentinel",
                        "path":"body > main > div#feed > div#scroll-sentinel",
                        "rect": { "top":9214, "height":1, "width":782 },
                        "in_viewport":false, "text_len":0 },
            "options": null } }
```

For `MutationObserver`, `data.options` carries the real init dict
(`{childList, subtree, characterData, attributes}`).

`target_count` counts how many nodes this observer has been given in total, so you can
tell a single sentinel from a lazy-image observer watching 200 nodes. **That distinction
is what stops us calling every `IntersectionObserver` infinite scroll.**

### `observer.stop`

```json
{ "v":1, "seq":420, "t":8100.2, "type":"observer.stop",
  "site": { "file":"https://x.com/feed.js", "line":340, "column":7, "fn":"teardown" },
  "cause": null,
  "data": { "api":"IntersectionObserver", "observer_id":3, "op":"disconnect" } }
```

`op` is `"disconnect"` or `"unobserve"`.

### `observer.fire`

The page's observer callback ran. `site` is carried from `observer.create`.

```json
{ "v":1, "seq":150, "t":6210.9, "type":"observer.fire",
  "site": { "file":"https://x.com/feed.js", "line":301, "column":22, "fn":"setupFeed" },
  "cause": null,
  "data": { "api":"IntersectionObserver", "observer_id":3, "fire_count":4,
            "duration_ms":0.9, "entry_count":1,
            "entries":[ { "target": { "tag":"div","id":"scroll-sentinel","cls":"sentinel",
                                      "path":"body > main > div#feed > div#scroll-sentinel",
                                      "rect":{"top":712,"height":1,"width":782},
                                      "in_viewport":true,"text_len":0 },
                          "isIntersecting":true, "intersectionRatio":1,
                          "boundingTop":712 } ] } }
```

For `MutationObserver`, `data` carries `records: {added, removed, attributes, characterData}`
counts instead of `entries`, capped and summarised — never the raw record list.

> **The `infinite_scroll` chain, stated once so we all read it the same way:**
> `observer.observe` on a low-`target_count` sentinel → `observer.fire` with
> `isIntersecting: true` → a `net.request` whose `cause` is `{type:"observer", id:<same>}`
> with `age_ms <= 2` → `dom.mutation_digest` showing `scroll_height` growth.
> Evidence line = the `site` of the `observer.observe`.
> `observed.metrics.auto_loads` = number of completed chains.
> `observed.metrics.user_confirmations` = number of those chains whose `cause` chain
> contains a `{type:"event"}` frame (i.e. a real click). **Count it; do not assume zero.**

### `net.request`

`fetch()` or `XMLHttpRequest.send()`.

```json
{ "v":1, "seq":151, "t":6211.4, "type":"net.request",
  "site": { "file":"https://x.com/feed.js", "line":288, "column":11, "fn":"loadPage" },
  "cause": { "type":"observer", "id":3, "age_ms":0 },
  "data": { "api":"fetch", "request_id":9, "method":"GET",
            "url":"https://x.com/api/feed?cursor=abc123", "same_origin":true,
            "open_site":null, "body_len":0 } }
```

For `api: "xhr"`, `site` is the `send()` call site and `data.open_site` is the `open()`
call site (often the more meaningful of the two — the URL is usually built there).

### `net.response`

`site` is carried from the request.

```json
{ "v":1, "seq":168, "t":6398.2, "type":"net.response",
  "site": { "file":"https://x.com/feed.js", "line":288, "column":11, "fn":"loadPage" },
  "cause": null,
  "data": { "request_id":9, "api":"fetch", "status":200, "ok":true,
            "duration_ms":186.8, "bytes":41822, "content_type":"application/json",
            "error":null } }
```

`bytes` comes from the `content-length` header and is `null` when absent — **the harness
never reads a response body.** Consuming a stream the page has not read yet would break
the page, and that is rule 1. On a network failure, `status: 0`, `ok: false`, `error` is
the message.

### `media.element_seen`

A `<video>`/`<audio>` entered the DOM. Exists so that **declarative** autoplay
(`<video autoplay>`, no script involved) can be reported honestly in `dropped` — it has
no call site and therefore cannot become a `Finding`.

```json
{ "v":1, "seq":30, "t":340.2, "type":"media.element_seen", "site":null,
  "cause": { "type":"observer", "id":0, "age_ms":0.4 },
  "data": { "media_id":1, "tag":"video", "autoplay_attr":true, "muted":true,
            "loop":true, "preload":"auto", "src":"https://x.com/v/clip.mp4",
            "node": { "tag":"video","id":"hero","cls":"bg",
                      "path":"body > section#hero > video#hero",
                      "rect":{"top":0,"height":420,"width":782},
                      "in_viewport":true,"text_len":0 } } }
```

### `media.play`

`HTMLMediaElement.prototype.play()` was **called**. Not proof it played — see
`media.state`.

```json
{ "v":1, "seq":34, "t":351.8, "type":"media.play",
  "site": { "file":"https://x.com/player.js", "line":77, "column":16, "fn":"autoStart" },
  "cause": null,
  "data": { "media_id":1, "tag":"video", "paused_before":true, "muted":true,
            "current_time":0, "duration":31.4, "autoplay_attr":true,
            "readyState":4, "in_viewport":true,
            "user_activation": { "is_active":false, "has_been_active":false } } }
```

⚠️ **`user_activation` is the whole `autoplay` discrimination and nothing else is.** A
`play()` with `is_active: false` and `has_been_active: false` was not initiated by the
user. If `has_been_active` is `true` the user has interacted with the page at some point,
and the claim is materially weaker — that is a `medium`, not a `high`. `is_active` is a
live read of `navigator.userActivation` at call time.

### `media.state`

What actually happened, from real media events (capture-phase, so it works despite media
events not bubbling). **This is `observed` in the `CONTRACT.md` sense** — measured
behaviour, not what the code says. `site` is carried from the `media.play` that started it,
or `null` for declarative autoplay.

```json
{ "v":1, "seq":40, "t":402.6, "type":"media.state",
  "site": { "file":"https://x.com/player.js", "line":77, "column":16, "fn":"autoStart" },
  "cause": null,
  "data": { "media_id":1, "state":"playing", "current_time":0.04, "muted":true,
            "played_ms":0 } }
```

`state` is `"playing"` \| `"pause"` \| `"ended"` \| `"play_rejected"`. `play_rejected`
carries `data.error` and means the browser's own autoplay policy stopped it — **that is
not our finding to claim.**

### `dom.text_write`

A script assigned `textContent` or `innerHTML`. **This is the only path to an
evidence-bound `countdown_timer` or `scarcity_message`** — text that a script wrote has a
call site; text that shipped in the HTML does not, and per `CONTRACT.md` rule 1 the
latter is a `dropped` entry, not a `Finding`.

```json
{ "v":1, "seq":141, "t":1415.4, "type":"dom.text_write",
  "site": { "file":"https://x.com/app.js", "line":91, "column":25, "fn":"tick" },
  "cause": { "type":"timer", "id":17, "age_ms":0 },
  "data": { "prop":"textContent", "value":"Offer ends in 00:04:59", "value_len":22,
            "truncated":false, "write_count":1,
            "node": { "tag":"span","id":"deal-timer","cls":"cd",
                      "path":"body > div.banner > span#deal-timer",
                      "rect":{"top":88,"height":19,"width":140},
                      "in_viewport":true,"text_len":22 } } }
```

`value` is truncated to 200 chars (`truncated: true` when it was). `write_count` is how
many times this site has written, including writes that were throttled away.

> `countdown_timer`: repeated `dom.text_write` from one `site_key` whose `value` holds a
> **decreasing** time-like string, with `cause` pointing at a ~1000 ms `setInterval`.
> Evidence line = the `site` of the `timer.schedule`, not of the text write — the timer is
> the mechanic; the write is the symptom. Both are available; pick deliberately.

### `dom.mutation_digest`

Aggregated every 250 ms by the harness's own `MutationObserver`, so a busy feed does not
produce ten thousand events. Emitted only when something changed. `site` is always `null`.

```json
{ "v":1, "seq":170, "t":6450.0, "type":"dom.mutation_digest", "site":null, "cause":null,
  "data": { "window_ms":250, "added_nodes":34, "removed_nodes":0, "attr_changes":12,
            "text_changes":3, "scroll_height_before":9400, "scroll_height_after":14100,
            "scroll_height_delta":4700,
            "top_containers":[ { "node": { "tag":"div","id":"feed","cls":"list",
                                           "path":"body > main > div#feed",
                                           "rect":{"top":-2100,"height":14100,"width":782},
                                           "in_viewport":false,"text_len":18400 },
                                 "added":30 } ] } }
```

`scroll_height_delta` is the strongest single infinite-scroll signal and is cheap. It is
sampled once per window, so it is a real measurement, not a per-mutation estimate.

### `kill.*`

Emitted by the kill-switch machinery. `kill.armed`, `kill.disarmed`, `kill.auto_disarmed`
carry `data: { action_id, mechanism, reason? }`. The one detectors may care about:

```json
{ "v":1, "seq":900, "t":15200.0, "type":"kill.suppressed",
  "site": { "file":"https://x.com/feed.js", "line":301, "column":22, "fn":"setupFeed" },
  "cause": null,
  "data": { "action_id":"disable_infinite_scroll", "hook":"observer.callback",
            "decision":"defer", "detail":"1 entry withheld", "suppress_count":3 } }
```

**A detector must not count suppressed activity as observed activity.** Once a switch is
armed, `auto_loads` stops rising because we stopped it, not because the site stopped.

---

## Ordering, volume and the guarantees you actually get

**Guaranteed.**
- `seq` is strictly increasing and totally orders everything. Sort by it, not by `t`.
- `session.start` is `seq: 0`.
- A `timer.fire` never precedes its `timer.schedule`; a `net.response` never precedes its
  `net.request`. Join on `timer_id` / `request_id`.
- Every event is valid JSON with all six envelope keys present.

**Not guaranteed.**
- **Completeness.** Events are dropped under budget. `harness.throttle` tells you exactly
  how many and of what — the counts survive even when the events do not. Build
  `observed.metrics` from throttle-adjusted counts.
- **That `site` is non-null.** See above. `null` is a legitimate outcome and it means
  `dropped`, not a guess.
- **That the page was patched in time.** `harness.patch_report.document_readyState` is the
  receipt. A site that captured `setTimeout` before us is invisible to us on that API.

### Why events are dropped — the measured reason

Capturing a call site costs a stack symbolization, and on V8 that is **~57 µs**, measured
on this machine at the default `Error.stackTraceLimit` of 10
(`extension/test/stackbench.js`). Constructing the `Error` without reading `.stack` is
**~3.4 µs** — 94% of the cost is the lazy symbolization. `setTimeout` is a hot path; a
site calling it 1000×/s would lose 5.7% of its main thread to us if we symbolized inline,
and **an instrumented page that visibly stutters is a broken page**.

So the harness does this instead:

1. **Hot path pays 3.4 µs.** Construct the `Error`, keep the object, do not read `.stack`.
2. **Symbolize at flush**, every 250 ms, off the page's synchronous path.
3. **Cache by callback identity.** A repeated `setInterval` callback is symbolized once.
4. **Prioritize.** `observer.create` / `observer.observe` / `media.play` / `net.request`
   are low-frequency and are the evidence anchors — they are **always** symbolized.
   `timer.schedule` and `dom.text_write` are symbolized under a per-flush budget; the
   overflow is emitted with `site: null` and `data.site_unresolved: true`.
5. **Cap per (type, site_key)**, then count instead of emit.

Worst case is bounded at roughly **60 symbolizations per 250 ms window ≈ 3.4 ms ≈ 1.4% of
one main thread**, and that is the number to quote if anyone asks what HOOKPRINT costs the
page it is measuring.

---

## Transport, and what it does and does not protect against

`instrument.js` (MAIN) batches events and hands them to `bridge.js` (ISOLATED) over
`window.postMessage`, because MAIN-world code has no `chrome.*` access. Batches flush
every **250 ms** or every **40 events**, whichever comes first, plus immediately on
`visibilitychange → hidden` and `pagehide` so the tail is not lost. The flush timer uses
the **stashed original** `setTimeout`, so the harness cannot be starved by its own patches
or by an armed kill switch.

Batch shape on the wire:

```json
{ "__hookprint": 1, "token": "<32 hex>", "session_id": "s_m4x9q1c7",
  "batch": 7, "events": [ /* … */ ] }
```

`bridge.js` rejects any message failing `event.source === window`,
`event.origin === location.origin`, `__hookprint === 1`, a pinned-token match, and a
strictly-increasing `seq`. It then re-batches (500 ms / 200 events) to keep the MV3
service worker from waking on every frame.

⚠️ **Stated plainly because overclaiming here would be the easy thing to do: this is
collision resistance, not security.** The token lives in a closure and is not reachable
from `window`, so page code cannot *read* it — but page code that registers its own
`message` listener can *observe* a batch and learn the token, then forge events. There is
no `postMessage` design that closes that hole. A page determined to defeat HOOKPRINT can
also simply not run the mechanic while we are watching. The namespacing exists to stop
accidental collision and casual spoofing, and that is what we will say on stage.

*(A `MessageChannel` handshake would make the traffic unobservable to page listeners.
Whether a `MessagePort` transfers reliably across Chrome's isolated/main world boundary is
**unverified** — it was not adopted because a silent transport failure costs the entire
demo.)*

---

## Known gaps in v1 — say these out loud rather than discovering them on stage

| Gap | Consequence |
|---|---|
| `requestAnimationFrame` is not patched. | A countdown or auto-advance driven by rAF is invisible. |
| `Error.stackTraceLimit = 0` set by the page. | Every `site` on that page is `null`; everything is `dropped`. We do not fight the page for it. |
| No source-map support. | On a minified bundle, `site` is honest but points at generated code. `worker.js` windows the snippet around `column`, so a 200 KB single-line bundle still yields a readable excerpt rather than a useless one. |
| `all_frames: false`. | Mechanics inside iframes (most embedded video) are not seen. |
| Scripts that captured an API before `document_start`. | Nothing to be done; `patch_report.document_readyState` exposes it. |
| XHR kill-switch `block`. | Not supported in v1 — a half-cancelled XHR leaves worse page state than an uncancelled one. Gate returns are reported and ignored. |
