# The BATON claim-corruption benchmark

`LOKI-ATTACK.md` finding 4:

> **"A gate with no measured false-positive rate is not a gate."**

251 passing unit tests across four packages, and not one of them produced a
corpus-level accuracy number. BATON's entire value proposition is that it says
*no*. Nobody had measured how often it says no to something that was fine.

This directory is that measurement. It reports **four numbers, two of them
unflattering**, because a benchmark that reported only the good one would be
committing the exact corruption this project exists to catch.

---

## TL;DR — the numbers, both modes

| | precision | recall | **false-positive rate** | F1 |
|---|---|---|---|---|
| **default** (claim-level, curated focus spans) | **100.0%** | **33.3%** | **0.0%** | **50.0%** |
| **`--raw`** (document-level, whole cited line) | **0.0%** | **0.0%** | **100.0%** | n/a |

Both rows come from the same 5 scored instances, the same real `gate()`, the
same real `diffClaim`. The only thing that changes is **how much text the
checker is pointed at.**

**Do not quote the top row alone.** The gap between the rows is the most
informative thing in this directory, and §"Why the two rows differ" names the
three specific mechanisms that produce it.

---

## The denominators, stated up front — read this before quoting anything

The headline row is computed over **five** scored instances: three corrupt, two
clean. Which means:

```
precision 100.0%  =  1 true positive  / (1 true positive + 0 false positives)
recall     33.3%  =  1 true positive  / (1 true positive + 2 false negatives)
FPR         0.0%  =  0 false positives / (0 false positives + 1 true negative)
```

**The false-positive rate is measured over exactly one instance that produced a
verdict at all.** The second clean instance (`B04`) returns `NO_VERDICT` — no
alignment was produced — so it lands in neither the false-positive nor the
true-negative bucket, and the FPR denominator is 1, not 2.

A "0% false-positive rate" over a denominator of one is a true statement and a
nearly worthless one. Reporting it without its base would be
**`denominator_loss`** — the same corruption class `B01` and `B06` are labelled
with, the class this whole project was built to detect, committed by the
project's own benchmark in its own README.

So it is stated here, in the third section, above the good news.

> **Copy rule for the pitch:** never write "100% precision, 0% false-positive
> rate" without "on 5 labelled instances (3 corrupt, 2 clean); the FPR
> denominator is 1." If that makes the number sound weak, the number *is* that
> weak, and saying so is the product demo.

---

## What the benchmark is

**12 labelled claim-corruption instances (`B01`–`B12`)**, harvested from three
real agent-written documents in `D:\Tenori_Hack\ideation\`:

- `raven-deep-trust.md`
- `zeus-confidence-routing.md`
- `loki-deep-trust.md`

All three were **written on 2026-08-27, before BATON existed**, by agents that
had never heard of a claim checker. Nothing was staged. Nobody wrote a corrupt
sentence on purpose. The corruption in this corpus is organic, which is the
only reason the numbers mean anything.

**Ground truth was independently recomputed from primary data** —
`D:\Projects\Stark-Core\state\dispatches.jsonl`, deduplicated on `key`,
last-write-wins — and never carried forward from any document's own summary.
That distinction is load-bearing: a benchmark whose ground truth came from the
same prose it is grading would be measuring self-consistency, not correctness.

### The four scope classes, and why only one of them is scored

The fixture does not treat all 12 instances as one pile. Each carries a `scope`:

| scope | n | scored? | what it is |
|---|---|---|---|
| `handoff_integrity` | 5 | **yes — this is the headline** | Origin and restatement both exist. BATON claims to have an opinion. |
| `origin_truth` | 5 | separately, as "correctly silent" | The figure was wrong *before* the first restatement; the restatement copied it faithfully. BATON is designed to be **silent** here. |
| `invention` | 1 | separately, as a coverage gap | A downstream claim with no origin anywhere. Default `gate()` emits no verdict. |
| `hard_case` | 1 | **excluded from the headline, printed anyway** | Genuinely ambiguous to a non-semantic checker. Hiding it would make the benchmark dishonest. |

Three honesty rules are baked into `run.js` rather than left to the reader:

1. **`origin_truth` rows are not counted as BATON failures.** The trust boundary
   says BATON cannot catch a figure that was wrong before the first restatement.
   Counting those as misses would be attacking a claim the project never made.
   But the inverse *does* count against us: a `REJECT` on one of these rows means
   the gate fired on a faithful restatement, and it is reported as such.
2. **`hard_case` rows are excluded from the headline and printed on their own
   line with the reasoning.** Dropping them silently is the exact sin this
   project exists to catch.
3. **Every number is computed at run time** from the fixture and the real
   pipeline. Nothing in the output is hard-coded.

---

## How to run it

Zero dependencies. No network. No LLM call. Deterministic — run it twice, get
the same bytes.

```bash
node bench/run.js              # headline metrics (claim-level, focus spans)
node bench/run.js --verbose    # per-instance detail; -v also works
node bench/run.js --raw        # document-level: ignore focus spans, feed the whole line
node bench/run.js --strict     # also gate invention (unaligned quantified claim -> REJECT)
node bench/run.js --json       # machine-readable {summary, results}, for CI
```

Flags compose: `node bench/run.js --raw --verbose` is the run that shows *why*
the raw numbers collapse, one instance at a time.

### Re-verifying the ground truth

```bash
node bench/recompute.js         # re-derive ground truth from primary data, report drift
node bench/recompute.js --write # update and re-stamp the fixture's ground-truth block
```

Exit code `0` = no drift, `1` = the fixture has gone stale, `2` = the primary
data file is not readable on this machine (the benchmark still runs; the
ground-truth block should be treated as **unverified**, not current).

**Run `recompute.js` before quoting any figure from `instances.json`.** The
underlying `dispatches.jsonl` is appended to live.

Measured, not hypothesised — the distinct-dispatch count over roughly one day:

```
309   as written in LOKI-ATTACK.md
311   first recompute of the fixture-building session
313   twenty minutes later, same session
315   at the final verification run of the session that wrote this README,
      after 313 had already been written into three pitch documents
      and before that edit was committed
```

**Decay rate: about two per recompute.** All three pitch documents held `311`
simultaneously, perfectly consistent with one another, and all three were wrong.
**No comparison of restatements can ever catch that** — the documents agreed.
Only recomputation from the primary file caught it, which is precisely why
origin truth sits outside BATON's trust boundary and is a different product.

`recompute.js` is the smallest working version of the `STALE_EVIDENCE` state
that `PROJECT-REFERENCE.md` §7 limitation 2 says BATON **does not have**. It
deliberately lives outside `packages/align`, because BATON does not re-verify
its own evidence and this directory will not imply that it does.

**Note that re-stamping does not move any metric in this README.** The
ground-truth block is metadata about the corpus; the scored instances carry
their own origin and restatement text. `--write` changes the stamp and nothing
else — verified by re-running `run.js` after a re-stamp and diffing the output.

---

## Literal output — `node bench/run.js`

```
BATON claim-corruption benchmark — BATON claim-corruption benchmark v1
corpus: raven-deep-trust.md, zeus-confidence-routing.md, loki-deep-trust.md (written 2026-08-27, before BATON existed)
mode:   default  (invention ungated — the default)
────────────────────────────────────────────────────────────────────────
HANDOFF INTEGRITY — what BATON claims to do. Scored.
  instances            5   (3 corrupt, 2 clean)
  true positives       1      corruption present and caught
  false negatives      2      corruption present and missed
  false positives      0      clean restatement wrongly rejected
  true negatives       1      clean restatement correctly passed

  precision            100.0%
  recall               33.3%
  FALSE-POSITIVE RATE  0.0%   <- the number LOKI-ATTACK.md §4 says nobody had
  F1                   50.0%
────────────────────────────────────────────────────────────────────────
TRUST BOUNDARY — what BATON says it CANNOT do. Reported, not scored as failure.
  origin-poisoning rows with a restatement   2
  correctly silent (ACCEPT, as designed)     1/2
────────────────────────────────────────────────────────────────────────
COVERAGE GAP — LOKI-ATTACK.md §2, measured rather than argued.
  invention rows (claim with no origin)      1
  ungated under default gate()              1
────────────────────────────────────────────────────────────────────────
HARD CASES — excluded from the headline, printed because hiding them would be dishonest.
  B07  expect REJECT, got REJECT  — value_drift/material:fail
────────────────────────────────────────────────────────────────────────
total labelled instances: 12
```

## Literal output — `node bench/run.js --raw`

```
  instances            5   (3 corrupt, 2 clean)
  true positives       0      corruption present and caught
  false negatives      3      corruption present and missed
  false positives      1      clean restatement wrongly rejected
  true negatives       0      clean restatement correctly passed

  precision            0.0%
  recall               0.0%
  FALSE-POSITIVE RATE  100.0%   <- the number LOKI-ATTACK.md §4 says nobody had
  F1                   n/a
```

Per-instance, `--raw --verbose`:

```
 MISS  B01  handoff_integrity  expect REJECT  got NO_VERDICT  no alignment produced (1 unaligned)
 MISS  B02  handoff_integrity  expect ACCEPT  got REJECT      denominator_loss/rebased:fail, unit_drift/measure_confusion:fail
 MISS  B04  handoff_integrity  expect ACCEPT  got NO_VERDICT  no alignment produced (1 unaligned)
 MISS  B06  handoff_integrity  expect REJECT  got NO_VERDICT  no alignment produced (1 unaligned)
 hard  B07  hard_case          expect REJECT  got NO_VERDICT  no alignment produced (1 unaligned)
 MISS  B12  handoff_integrity  expect REJECT  got NO_VERDICT  no alignment produced (1 unaligned)
```

---

## Why the two rows differ — the actual mechanisms, named

The fixture annotates each side of a pair with a **`focus` span**: the minimal
claim-bearing clause, taken verbatim from the cited line. Default mode uses it.
`--raw` discards it and hands `extract.js` the entire line, letting
`pickPrimary()` decide which quantity is under test — the realistic
document-granularity task.

The collapse is **not** a vague "hard problem." It is three specific, nameable,
individually fixable failures. Each was diagnosed by running `extract.js`
directly on the raw lines.

### 1 · Primary-selection disagreement → silent miss

`B01`'s origin line carries four quantities: `10 of ~18`, `29 occurrences`,
`2 of 252`, and `0.79%`. `pickPrimary()` returns `0.79%`. The restatement line
carries `~100%`, `50-91%`, and `0.79%` — and `pickPrimary()` returns **`~100%`**.

The harness then compares `0.79%` against `~100%`, finds no alignment, and emits
`NO_VERDICT`. **The corruption is invisible because the two sides selected
different facts to be about.** `B06` and `B12` fail identically.

This is a *silent* miss, not a wrong answer, which is the better of the two
failure modes — but it means document-granularity recall is **0/3**.

### 2 · Unit mis-attachment across a delimiter → the false positive

`B02` is the clean-restatement probe: `pete 18/25 (72%)` restated as
`pete 18 of 25 (72%)`. In `--raw` it is the benchmark's only false positive, and
the cause is precise.

The origin line is a pipe-and-dash-separated table row:

```
friday 2/37 (5%) - edith 5/18 (28%) - zeus 16/34 (47%) - beastboy 12/18 (67%) - pete 18/25 (72%)
```

`pickPrimary()` selects `5%` — friday's figure — and then binds it to the nearest
following noun token, which is **`edith`**, on the far side of the delimiter. On
the restatement line the same `5%` binds to **`pete`**. Same value, different
attached unit, so `diffClaim` correctly fires `unit_drift/measure_confusion` and
`denominator_loss/rebased` on a pair that is in fact clean.

**The differ is not wrong here. The extractor handed it a mislabelled pair.**
The fix is delimiter-aware unit attachment in `extract.js` — a bounded change to
one function, not a redesign.

### 3 · Cross-dimension restatement → alignment failure even on a clean pair

`B04` fails in **both** modes, and it is the most instructive row in the fixture.

- Origin: `friday 2/37 (5%)` → `pickPrimary()` returns `5%`, dimension `percent`.
- Restatement: `This worker finished 2 jobs out of 37.` → `pickPrimary()` returns
  `2`, dimension `count`, unit `jobs`.

A `percent` cannot align to a `count`, so no verdict is produced. But `2/37`,
`5%`, and `2 out of 37` are **the same fact in three surface forms**, and `B04`
is labelled `ACCEPT` precisely because heavy paraphrase is the normal case.

This is the honest limit on the headline claim *"BATON survives paraphrase."*
It survives **lexical** paraphrase. It does not yet survive **dimensional**
paraphrase — a restatement that expresses a rate as its underlying ratio, or
vice versa. Naming this is worth more than the 100% precision figure.

> Note the second-order honesty point: `B04`'s failure is what keeps the
> default-mode FPR denominator at 1. An alignment failure on a clean pair does
> not *look* like a false positive — it removes the instance from the FPR
> calculation entirely. A gate that fails to align often enough will report a
> flattering false-positive rate for exactly the wrong reason. That is why the
> `NO_VERDICT` count is printed alongside every metric and not folded into one.

### What the gap does and does not license you to say

**Fair:** *"At claim granularity — where the checker is pointed at the clause —
BATON is precise and does not misfire. At document granularity it currently
fails, and here are the three extractor bugs that cause it."*

**Not fair:** *"BATON achieves 100% precision."* Unqualified, that sentence is
true only of the curated-span condition, and omitting the condition is the
corruption class this repository exists to detect.

The claim-level condition is not cheating — it is the granularity the entire
summarization-faithfulness literature evaluates at (see `CONTENT-BRIEF.md` §7),
and the fixture's `annotation_note` says so. But it is a **stated condition**,
not a silent one, and `--raw` exists so anyone can check the harder number in one
command instead of taking our word for it.

---

## What the other scope classes measured

**Trust boundary (`origin_truth`, 2 rows with a restatement).** BATON returns
`ACCEPT` on `B03` and the number stays wrong — the trust boundary firing exactly
as specified. `B05` returns `REJECT`, and that is reported as a miss against the
trust boundary's own promise rather than quietly dropped: **1 of 2 correctly
silent.** Three further `origin_truth` rows (`B09`–`B11`) are single-mention
instances with no restatement, so there is no pair to check; they print under
`NOT SCORED`.

**Coverage gap (`invention`, 1 row).** `B08` is a downstream claim with no origin
anywhere in the corpus — what fabrication actually looks like. Default `gate()`
emits **no verdict**; it lands in the `unaligned[]` honesty receipt and the
pipeline proceeds. This is `LOKI-ATTACK.md` finding 2, measured rather than
argued. `--strict` gates it: the row flips to `REJECT · no_origin` and the
"ungated" count goes from **1 to 0**. Note that `--strict` changes nothing in the
headline row — invention is a separate axis from handoff integrity, and the
benchmark keeps them separate.

**Hard case (`hard_case`, 1 row).** `B07` restates `guards.present false on
378/378 = 100%` as `378 of 378 = 0.00%`. A non-semantic checker sees the surface
claim invert on the same base and fires `value_drift/material`. That is
defensible — a skimming reader genuinely would be misled — and it is also
arguably a typo rather than a corruption. It is excluded from the headline and
printed with its reasoning, because a benchmark that quietly decided its own
ambiguous cases in its own favour would not be evidence of anything.

---

## What this benchmark is not

- **It is not large.** Twelve instances, five of them scored. Every metric here
  has a single-digit denominator. It is a *floor* on rigor — the difference
  between a claim and a measurement — not a statistically powered evaluation.
- **It is not adversarial.** The corpus is organic agent output, not a
  hand-built attack set. It measures what BATON does to writing that occurred
  naturally, which is the honest thing to measure and also the easier one.
- **It is not a truth benchmark.** Every row measures handoff integrity. Origin
  truth is a different and harder problem that BATON does not claim (`§0`,
  `CONTENT-BRIEF.md`), and the `origin_truth` rows exist to demonstrate the
  boundary, not to be scored against it.
- **Its ground truth perishes.** `recompute.js` exists because the primary data
  file is live. The block in `instances.json` records *when it was last checked*,
  not an eternal fact.

---

## Files

| path | what it is |
|---|---|
| `bench/run.js` | The benchmark. Real `gate()`, real `diffClaim`, no mocks, no injected differ. |
| `bench/recompute.js` | Re-derives ground truth from primary data; reports or writes drift. |
| `bench/_diag.mjs` | Scratch diagnostic used while building the fixture. Not part of the benchmark. |
| `fixtures/benchmark/instances.json` | The 12 labelled instances, with `scope`, `class`, `focus` spans, `why_it_matters`, and the stamped ground-truth block. |

If a number in this README disagrees with what `node bench/run.js` prints on your
machine, **the program is right and this file is stale.** That is not a
disclaimer; it is the thesis.
