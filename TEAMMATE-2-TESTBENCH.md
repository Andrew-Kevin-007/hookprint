# HOOKPRINT — Teammate 2 Task Sheet: The Test Bench

**Read this whole file before writing any code. Everything you need is in here. You do NOT need to talk to anyone or wait for anyone to start.**

| | |
|---|---|
| **Your branch** | `testbench` |
| **Your folder** | `testbench/` — you own it completely. **Do not edit any file outside `testbench/`.** |
| **Stack** | Plain HTML + CSS + JavaScript. No frameworks, no build step, no npm. |
| **Deadline** | 2026-08-29 09:00 |

---

## What the project is (read once, 30 seconds)

HOOKPRINT is a Chrome extension. It opens any website, detects manipulative interface mechanics running on it (infinite scroll, autoplay, fake countdowns), points at the exact line of that website's own JavaScript doing it, and lets the user switch the supported ones off.

**You are not building the detector.** You are building the thing the detector gets tested against.

---

## Why your job is the most important one nobody thinks about

Kevin is writing code that claims *"this page has infinite scroll, on line 4412."*

**How does he know it's right?**

Right now, he doesn't. If he tests only on real websites, he can never be sure whether a miss is his bug or just a site that doesn't do that thing. He needs pages where **the correct answer is known in advance**, because he built them on purpose.

**That is what you are making: a set of small web pages that each deliberately contain exactly one known manipulative mechanic, plus an answer key.**

Without this, the detector is untested. With it, we can stand on stage and say what our accuracy is.

---

## Setup

```bash
git checkout -b testbench
mkdir testbench
mkdir testbench/pages
```

Commit after each finished task and push:
```bash
git add testbench/
git commit -m "testbench: <what you did>"
git push -u origin testbench
```

To view your pages:
```bash
cd testbench
python -m http.server 5501
```
Then open `http://localhost:5501/pages/01-infinite-scroll.html`.

---

## TASK 1 — Five trap pages (2 hours) — this is the main job

Create five HTML files in `testbench/pages/`. **Each one is a small, plain, self-contained page that does exactly ONE manipulative thing.** No frameworks. All JavaScript inline or in a sibling `.js` file so line numbers are stable and findable.

Make each page look like a plausible little website — a fake feed, a fake shop, a fake video page. It does not need to be pretty, but it must not be a blank page with one script tag, because that is too easy to detect and proves nothing.

### `01-infinite-scroll.html`
A list of ~20 items. When the user scrolls near the bottom, JavaScript automatically appends 20 more, forever, with no button and no click.
**Must use:** `IntersectionObserver` watching a sentinel element at the bottom.

### `02-autoplay.html`
A page with a `<video>` (use any small local file or a coloured `<canvas>` fake if you don't have one) that **starts playing by itself roughly 4–5 seconds after page load**, without the user clicking anything.
**Must use:** a `setTimeout` that calls `.play()`.

### `03-countdown.html`
A fake product page showing **"Offer ends in 04:59"** counting down live. When it hits zero, it silently resets back to 5:00 — the classic fake-urgency pattern.
**Must use:** `setInterval`.

### `04-scarcity.html`
A fake product page showing **"Only 3 left in stock!"** where the number decreases on its own every 20–30 seconds regardless of anything the user does.

### `05-clean.html` ← **do not skip this one**
A completely honest page. A normal article. Pagination with a real "Next page" button the user must click. No timers, no autoplay, no auto-loading, nothing manipulative at all.

**This page is the most valuable file you will write.** If HOOKPRINT reports a finding on this page, HOOKPRINT has a false positive — and that is the single thing we most need to know about before a judge finds it. Make it genuinely, boringly clean.

**Done when:** all five pages load and visibly do the thing they are supposed to do (or in `05`'s case, visibly don't).

---

## TASK 2 — The answer key (45 minutes)

Create `testbench/answer-key.json`. This states the correct answer for each page — the ground truth the detector gets graded against.

**Use exactly this shape and exactly these value strings:**

```json
{
  "pages": [
    {
      "file": "pages/01-infinite-scroll.html",
      "expected_mechanisms": ["infinite_scroll"],
      "trigger_file": "pages/01-infinite-scroll.js",
      "trigger_line": 14,
      "trigger_snippet": "observer.observe(sentinel);",
      "notes": "IntersectionObserver on bottom sentinel appends items with no user action"
    },
    {
      "file": "pages/05-clean.html",
      "expected_mechanisms": [],
      "trigger_file": null,
      "trigger_line": null,
      "trigger_snippet": null,
      "notes": "Honest control page. Any finding here is a FALSE POSITIVE."
    }
  ]
}
```

**`expected_mechanisms` values must be exactly one of these strings** (this list is frozen — do not invent new ones):
`infinite_scroll` · `autoplay` · `variable_interval_refetch` · `countdown_timer` · `scarcity_message`

For `05-clean.html`, `expected_mechanisms` **must be an empty array** `[]`.

**`trigger_line` must be the real line number** in your own file where the mechanic is triggered. Open your file, count the line, write it down. Get this exactly right — it is what we grade the "points at the exact line" claim against.

**Done when:** the file is valid JSON, has all 5 pages, and every `trigger_line` genuinely matches the line in the file it points at.

---

## TASK 3 — The index page (30 minutes)

Create `testbench/index.html`: a simple linked list of all five test pages, each with a one-line description of what it does and what should be detected.

This is what Kevin opens to run through the whole suite quickly.

**Done when:** you can click through to all five pages from one screen.

---

## TASK 4 — The real-site shortlist (1 hour) — no coding

Create `testbench/real-sites.md`.

Find **10 real, public websites** that anyone can open without logging in, that you believe contain at least one of our five mechanics. For each, write:

- The URL
- Which mechanic(s) you think it has
- **How confident you are: high / medium / low**
- One sentence on what you actually observed (e.g. *"scrolled to bottom, 3 more batches loaded on their own"*)

**Rules for choosing sites:**
- **No login required.** If it needs an account, it is useless to us on stage.
- **Prefer well-known sites** a judge will recognise instantly.
- **Actually open each one and check.** Do not guess from memory. Write only what you saw.
- Include **at least 2 sites you believe are clean** — no manipulative mechanics at all. We need honest negatives as much as positives.

**Why:** at hour 11 Kevin has to demo against sites the project has never been opened on before, to prove it generalises rather than being tuned to specific pages. Your list is where those come from. If your confidence labels are honest, they are useful. If you pad the list with guesses, it is worse than useless — say `low` freely.

**Done when:** 10 sites, each personally checked, each with an honest confidence label.

---

## Rules

1. **Never edit files outside `testbench/`.** If you think you need to, message Kevin instead.
2. **Never change the mechanism value strings** in the answer key. That list is frozen.
3. **Push to the `testbench` branch only.** Never to `main` or `master`.
4. Commit after each completed task.
5. **Write only what you actually observed** in Task 4. A guessed observation is worse than no entry — we may say these numbers out loud on stage.
6. If a task takes more than double its estimate, stop and message Kevin.

---

## If you finish early

Message Kevin. The most useful extra work is **more trap pages** — a second infinite-scroll page implemented a *different* way (e.g. scroll-event listener instead of `IntersectionObserver`) is genuinely valuable, because it tests whether the detector generalises or just recognises one pattern. But ask first.
