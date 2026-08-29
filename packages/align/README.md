# `packages/align` — the depth core

Three agents pass a research brief down a chain. Each one rewrites the last one's
claims **in its own words and carries no ID**. This package re-identifies each
paraphrased restatement against the claim it came from, then diffs the pair for
four corruption classes.

Deterministic. Zero dependencies. No network. No LLM. **The agents are models;
the checker is not.**

```bash
cd packages/align
npm test          # or: node --test
```

---

## The one hard invariant

> **Origins and candidates MUST be parsed by the same code path — `extract.js`.**

If the origin document is parsed by one routine and the downstream document by
another, `diff.js` stops comparing a claim to its restatement and starts
comparing **two parsers' opinions**. Every difference in tokenisation, unit
splitting, or sentence boundary then becomes a delta that no agent caused — a
phantom `value_drift` on stage, in front of a panel that is specifically hunting
for props.

This is enforced, not merely documented. `contract.js` validates the shared core
(`text · span · ordinal · quantity · numerator · denominator · unit · caveats`)
through one function, `validateParsedCore`, and **both** `makeClaim` and
`makeCandidate` call it. A Claim and a Candidate cannot have divergent shapes
because there is only one definition of the shape.

The wrappers differ; the core does not.

| | wrapper adds | why |
|---|---|---|
| `Claim` | `id`, `hop`, `evidence{source,sha256,span,quote}` | it is the object `packages/sign` signs, and the thing a judge clicks |
| `Candidate` | `cid`, `hop`, `file`, `sha256`, `neighbours{prevSpan,nextSpan}` | working data; `neighbours` is how a *hoisted* caveat is told apart from a *stripped* one |

If you find yourself writing a second parser "just for candidates", stop. That
is the failure this package is built to prevent.

---

## Module dependency order

Build and read in this order. Nothing depends on anything to its right.

```
lexicon → text → quantity → contract → extract → mint → score → align → diff → evidence → index → report
```

| module | owns — its single responsibility |
|---|---|
| `lexicon.js` | The only place vocabulary lives: stopwords, `stem()`, unit synonyms, and the hedge / scope / condition / temporal / uncertainty / comparison-basis term lists that become caveats. |
| `text.js` | Document primitives: sentence and token splitting with exact offsets, and the O(n) position index. |
| `quantity.js` | Parse a numeric expression out of one sentence into a `Quantity` (+ numerator, denominator, unit), **including the precision band**. |
| `contract.js` | **Frozen.** The data shapes, the enums, the throwing constructors, and the canonical sort order. |
| `extract.js` | **The one parser.** Document → `Parsed[]`. Origins and candidates both come from here. |
| `mint.js` | Origin `Parsed[]` → `Claim[]`: allocate `c_NNN`, attach evidence, drop anything that is not a quantified assertion. |
| `score.js` | The three channels for one (claim, candidate) pair — `NUM`, `LEX`, `POS` — and their combination into one score. |
| `align.js` | Score matrix → a matching: `matched` / `ambiguous`, the monotonic-order constraint, and an `unaligned` receipt for everything else. |
| `diff.js` | An aligned pair → `Delta[]` across the four classes. **Denominator first** — it is the differentiator. |
| `evidence.js` | `sha256` over source file bytes, span → quote resolution, pointer construction. |
| `index.js` | The public entry point and the only module other packages import: `run(originFile, downstreamFiles) → Report`. |
| `report.js` | Assemble and render the canonical `Report`. No clock, no randomness. |

`contract.js` sits mid-chain deliberately: it depends on nothing (not even
`lexicon`), so every module above and below it can import it freely without a
cycle. **Nothing imports `index.js` from inside this package.**

---

## The six decisions the contract encodes

Stated in full at the top of `contract.js`. In brief:

1. **One parser** — above.
2. **Spans are JavaScript string indices, not byte offsets.** `{start, end}` are
   half-open indices into the file read as `utf8` — the unit `String.slice` uses.
   `sha256` is over the file **bytes**; the span indexes the decoded **string**.
   Two different units, each stated, because the ideation corpus contains
   em-dashes, arrows and `₹`, and mixing them puts a judge's click on the wrong
   sentence. *(BUILD-PLAN.md says "byte index" for `text.js`; overridden here,
   with this reason.)*
3. **Do not align on the number, and do not let an ambiguous match speak.** Value
   drift is a corruption class, so an aligner requiring numeric agreement can
   never reach its own headline finding. `makeReport` **refuses** a `Delta`
   whose alignment carries `decision: 'ambiguous'`. A wrong match producing a
   confident `value_drift` is worse than an honest `unaligned` row.
4. **The receipt is part of the product.** `unaligned[]` and `dropped_claims[]`
   take reasons from frozen lists, so the receipt is countable and renderable.
   Never fabricate a match to fill the table.
5. **No clock, no randomness, no network.** A `Report` carries no timestamp and
   no generated id. Two runs over the same bytes produce byte-identical JSON.
6. **Constructed objects are already canonical.** Every constructor fixes its key
   order, so `JSON.stringify(claim)` is a canonical encoding with no sorting
   step. `packages/sign` signs that string directly.

---

## The shapes, in one screen

```js
Span      = { start, end }                    // JS string indices, half-open, end > start
Quantity  = { raw, value|null, dimension, vague, band:[lo|null, hi|null], precision, span }
Magnitude = { value, unit|null, unitStem|null, provenance, span }   // numerator AND denominator
UnitRef   = { term, stem, span }
Caveat    = { kind, term, span }

Parsed    = { text, span, ordinal, quantity|null, numerator|null, denominator|null, unit|null, caveats:[Caveat] }

Claim     = { id:'c_001', hop, ...Parsed-core, evidence:{source, sha256, span, quote}, ordinal }
Candidate = { cid:'h2_014', hop, file, sha256, span, ...Parsed-core, neighbours:{prevSpan, nextSpan}, ordinal }

Alignment = { claimId, cid, hop, score, margin, channels:{NUM,LEX,POS},
              decision:'matched'|'ambiguous', runnerUp:{claimId,score}|null, supporting:[cid] }

Delta     = { class, subtype, severity, hop, claimId, cid, message,
              evidence:{origin:Pointer, restatement:Pointer}, consequential?, consistentDownstream? }
Pointer   = { file, sha256, span, quote }

Report    = { contract_version, alignments:[Alignment], deltas:[Delta],
              unaligned:[{cid, reason, detail?}], dropped_claims:[{claimId, reason, detail?}] }
```

### Rules a constructor will throw on

- `text.length` must equal `span.end - span.start`, and the same for
  `evidence.quote`. **The text must be exactly `source.slice(span.start, span.end)`.**
  If you need a normalised form, recompute it from `lexicon.js` — keep it out of
  the contract. A normalised string with an unnormalised span is the bug that
  lands the judge's click on the wrong sentence.
- A `Claim` **requires** a quantity; a `Candidate` may carry `quantity: null`.
  That asymmetry is deliberate: a claim is a quantified assertion, while
  candidates are harvested from every sentence and a null-quantity candidate is
  exactly what earns the `no_quantity` receipt (the honesty floor, mechanised).
- A `cid` must agree with its own `hop` — `h2_014` with `hop: 3` is refused.
- `band` may be open on either side (`[200, null]` for "more than 200"). Treat
  `null` as unbounded; do not invent a ceiling.
- `value` may be `null` only on a vague quantity with no number at all ("most"),
  and then the band must carry at least one finite bound. Writing a number there
  would be a fabrication.
- `Delta.evidence` is required — pass `claim` and `candidate` objects instead
  and both pointers are derived for you. A delta that cannot show the origin
  sentence **and** the restatement is an accusation.
- Optional flags are **absent**, never present-and-`undefined`.

### Frozen vocabularies

`DELTA_CLASSES` (`value_drift`, `unit_drift`, `denominator_loss`, `caveat_loss`)
· `SEVERITIES` (`fail`, `warn`, `note`) · `DECISIONS` · `DIMENSIONS` ·
`CAVEAT_KINDS` · `PROVENANCE` · `UNALIGNED_REASONS` · `DROPPED_CLAIM_REASONS`.

`class` and `severity` are frozen hard — they are the vocabulary on the slide,
and changing one is expensive. **`subtype` is deliberately not frozen**: it is
cheap to change, `diff.js` is being written right now, and a contract that
blocks a subtype nobody anticipated is a contract getting in the way of the work.
It must merely be `lower_snake_case`. `KNOWN_SUBTYPES` is a starting vocabulary,
not a fence.

---

## Verification

```bash
node --test                 # auto-discovery — works
npm test                    # node --test tests/*.test.js — works, Node expands the glob
node --test tests/          # BROKEN on Node 24.11.1 — treats the directory as one test file
```

Measured on Node v24.11.1, 2026-08-28: `node --test tests/` fails; the other two
pass. The `npm test` script survives `cmd.exe` on Windows because Node expands
the glob itself rather than relying on the shell.

`tests/contract.test.js` is the shape regression suite — 37 tests. It already
mechanises two of the verification gates from BUILD-PLAN.md:

- **#16 determinism** — shuffling every input array leaves the report
  `deepEqual` *and* byte-identical as JSON.
- **#3 / #4 safety** — a delta cannot be emitted from an ambiguous alignment, so
  the aligner cannot cheat by matching on the number.

Add a case here before changing a shape. If this suite is red, the parallel
streams are already diverging.

---

## What this package will not do

Per BUILD-PLAN.md, out of scope and not to be added: any LLM in the checker,
coverage beyond the four corruption classes, a reputation score, and chain
anchoring of hashes.
