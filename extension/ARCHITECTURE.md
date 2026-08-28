# Extension architecture — read before writing a line in `src/`

## The one thing that makes this work

**`instrument.js` runs in the MAIN world at `document_start`.**

Both halves of that matter and neither is optional:

- **MAIN world** — a normal Chrome content script runs in an *isolated* world. It sees the DOM but gets its own copies of `IntersectionObserver`, `setTimeout`, `fetch`. Patching them there patches nothing the page will ever call. `"world": "MAIN"` puts our code in the same JavaScript context the page's own code runs in. **Without this, every patch is invisible and every detector reports nothing.**
- **`document_start`** — the patch must be installed *before* the page's own scripts run. A site that sets up its `IntersectionObserver` before we patch it is a site we cannot see.

If detection silently returns empty on every site, check these two fields first.

## The two-world split

| File | World | Can it patch page APIs? | Can it use `chrome.*`? |
|---|---|---|---|
| `src/instrument.js` | MAIN | ✅ yes | ❌ no |
| `src/bridge.js` | ISOLATED | ❌ no | ✅ yes |

MAIN-world code has no access to extension APIs. So `instrument.js` collects evidence and hands it over by `window.postMessage`; `bridge.js` listens, and is the only thing that talks to the service worker.

```
page's own JS
     │  calls IntersectionObserver / setTimeout / play()
     ▼
instrument.js   (MAIN)      patched APIs, capture stack → file:line
     │  window.postMessage
     ▼
bridge.js       (ISOLATED)  chrome.runtime.sendMessage
     │
     ▼
worker.js       (service worker)  → backend /classify → Manifest
     │
     ▼
panel/          Bill of Materials
```

## How we get `file:line` — the whole trick

Inside a patched function, construct an `Error` and read its stack. The frame directly above our patch is the page's own calling code.

```js
function captureCallSite() {
  const stack = new Error().stack.split("\n");
  // stack[0] = "Error"
  // stack[1] = this function
  // stack[2] = the patched API wrapper
  // stack[3] = the page's own code   ← the frame we want
  return parseFrame(stack[3]);   // → { file, line, column }
}
```

This is the OpenWPM / FP-Inspector technique. It is used in web-privacy research to catch fingerprinting scripts. **We did not invent it — we are pointing it at compulsion mechanics instead. Say that first, on stage.**

Frame formats differ (`at fn (url:line:col)` vs `at url:line:col`). Handle both.

## Rules

1. **Never throw from inside a patch.** If our instrumentation errors, we break the host page. Every patched function wraps its own logic in `try/catch` and, on any failure, calls straight through to the original. **Breaking a real site on stage is a worse outcome than detecting nothing.**
2. **Always call the original.** Patches observe. They do not change behaviour — until a kill switch is explicitly armed for that mechanic.
3. **Keep the originals.** Stash every original function at patch time. Kill switches need them, and so does rollback.
4. **A finding with no resolvable `file:line` is dropped**, per `CONTRACT.md`. Not shown, not guessed.

## Kill switches — the part that is harder than it looks

Detecting infinite scroll and *safely disabling it without breaking the page* are different problems. Suppressing the wrong callback turns a real site into a blank screen.

Every switch must:
- suppress only the specific mechanic, never the whole API
- leave the page functional and verified so afterwards
- be reversible — a rollback path exists and is tested

**Supported mechanics only.** Anything we cannot switch off safely stays detected and labelled `NOT SUPPORTED`. That is a deliberate position, not a gap.

## Files

| File | Status | Owner |
|---|---|---|
| `src/instrument.js` | scaffold | Kevin / cyborg |
| `src/bridge.js` | scaffold | Kevin / cyborg |
| `src/worker.js` | scaffold | Kevin / cyborg |
| `panel/` | — | Teammate 1 (`ui` branch), merged in |
