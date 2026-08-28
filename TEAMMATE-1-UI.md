# HOOKPRINT — Teammate 1 Task Sheet: The Bill of Materials Panel

**Read this whole file before writing any code. Everything you need is in here. You do NOT need to talk to anyone or wait for anyone to start.**

| | |
|---|---|
| **Your branch** | `ui` |
| **Your folder** | `ui/` — you own it completely. **Do not edit any file outside `ui/`.** |
| **Stack** | Plain HTML + CSS + JavaScript. No React, no build step, no npm. |
| **Deadline** | 2026-08-29 09:00 |

---

## What the project is (read once, 30 seconds)

HOOKPRINT is a Chrome extension. It opens any website, detects manipulative interface mechanics running on it (infinite scroll, autoplay), points at the exact line of that website's own JavaScript doing it, and lets the user switch the supported ones off.

**You are not building the extension. You are not detecting anything.** You are building the panel that displays the results — a single screen we call the **Bill of Materials**.

**You can build and test your entire piece by opening one HTML file in a browser.** You never need Chrome extension mode, the backend, or anyone else's code.

---

## Why this panel matters

This panel *is* the demo. On stage, a judge names a website, and this panel is what appears. It has to communicate four things in one glance, in this order:

> **claim → evidence → behaviour → intervention**

That is the entire thesis of the project on one screen. Make it legible and confident. Dense is fine; vague is not.

---

## THE CONTRACT — never change these shapes

Everything is driven by one JSON file. Your panel reads it and renders it. **These field names and value strings are frozen. Do not rename, add, or remove fields.** If something looks wrong, message Kevin — do not fix it yourself.

```json
{
  "url": "https://example.com/feed",
  "scanned_at": "2026-08-28T14:30:00Z",
  "findings": [
    {
      "id": "f_001",
      "mechanism": "infinite_scroll",
      "display_name": "Infinite Scroll",
      "confidence": "high",
      "evidence": {
        "file": "https://example.com/static/main.js",
        "line": 4412,
        "column": 18,
        "snippet": "observer.observe(sentinel); // fetchNextPage()"
      },
      "observed": {
        "summary": "7 automatic content loads, 0 user-confirmation events",
        "metrics": { "auto_loads": 7, "user_confirmations": 0 }
      },
      "action": {
        "supported": true,
        "label": "Disable infinite loading",
        "action_id": "disable_infinite_scroll"
      }
    }
  ],
  "dropped": [
    {
      "proposed_mechanism": "variable_interval_refetch",
      "reason": "no resolvable node"
    }
  ]
}
```

**`mechanism` is always one of exactly these strings:**
`infinite_scroll` · `autoplay` · `variable_interval_refetch` · `countdown_timer` · `scarcity_message` · `unknown`

**`confidence` is always one of exactly these strings:**
`high` · `medium` · `low`

**`action.supported` is `true` or `false`.** When it is `false`, there is no `label` and no `action_id` — the row must show **`NOT SUPPORTED`** instead of a button. This is important and is explained in Task 3.

---

## Setup

```bash
git checkout -b ui
mkdir ui
```

Commit after every finished task and push:
```bash
git add ui/
git commit -m "ui: <what you did>"
git push -u origin ui
```

---

## TASK 1 — The fixture file (20 minutes)

Create `ui/fixture.json`.

Copy the contract JSON above into it, then **extend it to contain 4 findings and 2 dropped entries**, so you have realistic content to design against:

1. `infinite_scroll` — confidence `high`, **supported: true**
2. `autoplay` — confidence `high`, **supported: true**, label `"Disable autoplay"`, action_id `disable_autoplay`
3. `countdown_timer` — confidence `medium`, **supported: false**
4. `variable_interval_refetch` — confidence `low`, **supported: false**

Make up plausible file URLs, line numbers, code snippets and observed summaries. They only need to look real.

**Done when:** the file is valid JSON (paste it into any JSON validator) and has 4 findings and 2 dropped entries.

---

## TASK 2 — Render the panel (1.5 hours)

Create `ui/panel.html`, `ui/panel.css`, `ui/panel.js`.

`panel.js` loads `fixture.json` with `fetch()` and renders one card per finding.

> ⚠️ `fetch()` on a local file is blocked by the browser. Run a tiny local server instead:
> ```bash
> cd ui
> python -m http.server 5500
> ```
> then open `http://localhost:5500/panel.html`.

**Each card must show all five things, clearly separated:**

| Row | Content | Notes |
|---|---|---|
| **Mechanism** | `display_name` | The headline. Biggest text on the card. |
| **Confidence** | `high` / `medium` / `low` | Colour-code it: high = red, medium = amber, low = grey. |
| **Evidence** | `file`, `line`, and the `snippet` in a monospace block | Show the file as just the filename + line, e.g. `main.js:4412`. Full URL on hover. |
| **Observed** | `observed.summary` | This is the proof it actually happened, not just that the code exists. Give it weight. |
| **Action** | a button labelled `action.label` | See Task 3 for the `supported: false` case. |

At the top of the panel, a header showing the scanned `url` and how many findings there are.

**Done when:** you open the page and see 4 well-formed cards with all five rows populated from the fixture.

---

## TASK 3 — The NOT SUPPORTED state (30 minutes) — this one is important

When `action.supported` is `false`, the card must **not** show a button. It must show a clearly styled, muted **`NOT SUPPORTED`** label instead.

**Do not hide these cards. Do not grey the whole card out into invisibility.** They must be readable and obviously present.

**Why this matters, so you get the tone right:** we detect more mechanics than we can safely switch off. Showing what we found but deliberately did *not* touch is a statement of honesty, and a judge will specifically look for whether we overclaim. This state should read as *deliberate*, not as *broken* or *coming soon*. Never write "coming soon".

**Done when:** cards 3 and 4 from your fixture show `NOT SUPPORTED` with no button, and still look intentional.

---

## TASK 4 — The dropped panel (30 minutes)

Below the findings, add a small collapsible section:

> **`12 candidate mechanics discarded — no resolvable evidence`** *(click to expand)*

Expanded, it lists each entry from the `dropped` array: the `proposed_mechanism` and the `reason`.

**Why this exists:** the rule of this project is that a finding with no resolvable line of code gets thrown away rather than shown. This section is the receipt for that discipline — it is the answer to a judge asking "how do we know you're not just flagging everything?"

Collapsed by default. Small, quiet, but present.

**Done when:** it toggles open and closed and lists your 2 dropped entries.

---

## TASK 5 — Wire the buttons to nothing, safely (20 minutes)

Each action button, when clicked, should:
1. Log `action_id` to the console
2. Change its own label to **`DISABLED ✓`** and become non-clickable

**Do not implement any actual page-disabling logic.** Kevin owns that entirely. Your button just needs to visually confirm a click. He will connect the real behaviour later by calling a function you expose.

Expose exactly this function in `panel.js` so his code can plug in:
```javascript
window.HOOKPRINT_UI = {
  onAction: (action_id) => { /* Kevin replaces this */ }
};
```
Your button calls `window.HOOKPRINT_UI.onAction(action_id)`.

**Done when:** clicking a button flips it to `DISABLED ✓` and logs the id.

---

## Design notes

- **Dark background.** This sits on top of real websites and must look like an instrument, not a webpage.
- Monospace for all code, file names, and line numbers.
- Panel width around 380px — it will live as a side panel.
- No animations, no gradients, no rounded-everything. This should look like a diagnostic tool, because it is one.
- It must be readable in a screenshot from three metres away. That is a literal requirement — it will be on a projector.

---

## Rules

1. **Never edit files outside `ui/`.** If you think you need to, message Kevin instead.
2. **Never change the contract field names or the allowed value strings.**
3. **Push to the `ui` branch only.** Never to `main` or `master`.
4. Commit after each completed task.
5. If a task takes more than double its estimate, stop and message Kevin rather than pushing through.
6. **Never write the words "coming soon", "beta", or "under construction" anywhere in the UI.**

---

## If you finish early

Message Kevin. Do not invent new features — there is a specific list of remaining work and he knows what is on it.
