# HOOKPRINT

**Open a site. HOOKPRINT prints the compulsion mechanics running on you, names the line of the page's own shipped JavaScript responsible, and lets you switch the supported ones off.**

Tenori Hack · Track 01, The Attention Economy · Team 14

---

## The problem

Every existing tool in this space is a blocklist. They work by knowing a site's name in advance — one popular extension disables infinite scroll by blocking scripts from a domain literally called `infinite-scroll.com`. The moment a site changes, or a site nobody has catalogued yet does the same thing, they see nothing.

**HOOKPRINT does not use per-site rules.** It reads the page's own shipped JavaScript, instruments what that code actually does at runtime, and identifies the mechanic from behaviour — on sites it has never seen before.

## What it shows you

For each mechanic found, one row:

| | |
|---|---|
| **Mechanism** | what it is |
| **Confidence** | how sure we are |
| **Evidence** | the file and line of *their* code doing it |
| **Observed** | what actually happened — *"7 automatic content loads, 0 user-confirmation events"* |
| **Action** | a switch, or `NOT SUPPORTED` |

**Claim → evidence → behaviour → intervention**, on one screen.

## What it deliberately does not do

**We detect more than we switch off.** Safely disabling a mechanic without breaking the page is a harder problem than detecting it, and we would rather show a finding we chose not to touch than break a site to prove a point. Unsupported mechanics are shown, labelled, and left alone.

**A finding with no resolvable line of code is discarded, not shown.** Candidates that cannot be tied to real evidence go into a visible dropped list with the reason. That list is part of the output, not hidden.

**We report signals, not intent.** Variable-interval event timing is a behavioural signal consistent with a variable-ratio reward schedule — it is not proof that anyone built it that way, and we do not claim otherwise.

**We do not rule on legality.** These are patterns subject to increasing regulatory scrutiny. We tell you what is running and where; what that means legally is not ours to say.

## Prior art

The instrumentation technique — patching an API, throwing a controlled `Error`, and reading the stack for file, function, line and column — comes from web-privacy measurement work (OpenWPM, FP-Inspector), where it is used to catch browser fingerprinting.

**The technique is theirs. Pointing it at compulsion mechanics is ours.**

## Architecture

```
Chrome MV3 extension
├── content script    instrumentation + detectors + kill switches
├── service worker    coordination
└── Bill of Materials panel

Local FastAPI backend  → local 8B model (llama.cpp) for mechanism classification
                          falls back to deterministic matching when unavailable
```

Everything runs locally. **A tool that audits your attention while uploading your browsing history has reproduced the problem it claims to solve.** No page content leaves the machine.

## Repository layout

| Path | Contents |
|---|---|
| `CONTRACT.md` | The frozen data contract every component is written against |
| `extension/` | Chrome MV3 extension |
| `backend/` | Local FastAPI classification service |
| `ui/` | Bill of Materials panel |
| `testbench/` | Trap pages with known mechanics, plus the answer key |

## Status

Built in ~14 hours for Tenori Hack. See `CONTRACT.md` before changing anything that crosses a component boundary.

## Licence

MIT — see [LICENSE](LICENSE).
