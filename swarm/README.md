# `swarm/` — the live researcher/summariser/writer pipeline

Three roles, three real model calls, one prompt each: **researcher** writes a
short note with a quantified claim and its explicit base; **summariser**
condenses it in its own words; **writer** polishes that into a final
paragraph. Nothing here is scripted to fail. If a number drifts, a
denominator disappears, or a caveat gets silently dropped along the way,
that happened because a real model condensed real text that way — the same
organic phenomenon BUILD-PLAN.md and CONTENT-BRIEF.md cite as the reason this
corruption class is real and not invented for the pitch.

## Status in this environment — **not yet run against a live model**

This was built and offline-tested inside a sandboxed build environment with
no outbound-billing credentials. Checked, thoroughly, before concluding that:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` — unset (checked via the shell
  environment and Windows user/machine environment variables directly, not
  just the shell's inherited copy).
- `ANTHROPIC_FEDERATION_RULE_ID` / WIF vars — unset.
- `ant auth login` profile — the `ant` CLI itself is not installed on this
  machine (`ant auth status` → command not found), so there is no profile to
  fall back to either.
- No `.env` file anywhere under the repo root.

**No live pipeline run has happened. No fixture under `fixtures/generated/`
exists yet, and `briefs/` is empty** (see `briefs/README.md`). The primary,
already-verified demo fixture is `fixtures/real-corpus/` (see its
`MANIFEST.md`) — that one is real, historical, and requires no key. This
package is the second, on-demand fixture source, fully built and ready the
moment a key is available.

### What *was* verified without a key

Everything that doesn't require calling the model:

- `npm install` — resolves cleanly, `@anthropic-ai/sdk@0.122.0`.
- `node --check` on every source file — no syntax errors.
- The full offline test suite (`npm test`, 9/9 passing) — exercises prompt
  chaining, scenario selection, file writing, and credential detection with
  a stubbed `generate()`, no network call.
- `node run.js` run for real, twice, against this credential-less
  environment — confirms the CLI's error path is correct end to end,
  including a real bug this caught and fixed (below).

## A real bug this found, before any live-key run

Running `node run.js` by hand (not just the offline test suite) surfaced a
genuine defect: with **no** credential configured at all, the Anthropic SDK
never reaches the network — it throws a plain `Error` at header-build time
("Could not resolve authentication method...") which is *not* an
`instanceof Anthropic.AuthenticationError` (that class wraps an actual HTTP
401 response; there was none here to derive it from). The original catch
block in `run.js` only checked `instanceof Anthropic.AuthenticationError`,
so this exact case fell through to the generic branch and printed a raw SDK
stack trace instead of guidance. Fixed by also matching the message; see the
comment at the fix site in `run.js` and the regression test
`test/run-cli.test.js`, which spawns the real CLI with credentials stripped
and asserts the friendly message appears and the stack trace does not.

This is mentioned here on purpose — it is the kind of defect that would
otherwise only surface for the first person to run this with a real key
under time pressure at the venue, at the worst possible moment.

## How to run it for real

```bash
cd swarm
npm install                 # once
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN, or `ant auth login`
npm run demo                # = node run.js — 8 runs by default
# or:
node run.js --runs 5
node run.js --runs 3 --out ./tmp        # write somewhere other than fixtures/generated/
node run.js --scenario "a two-week trial of a simplified checkout flow, tested against a small sample of returning customers"
```

Defaults to `claude-opus-5`. Override with `BATON_SWARM_MODEL` (e.g.
`BATON_SWARM_MODEL=claude-haiku-4-5` for a cheaper sweep across many runs
before committing to a full `claude-opus-5` pass).

## Workflow: from a generated run to a demo fixture

`run.js` writes **every** run to `fixtures/generated/run-NN/` — it does not
and cannot judge which run shows organic corruption. That takes a human (or
`packages/align`, which this package deliberately never imports —
BUILD-PLAN.md: *"OUT: any LLM in the checker. Agents are models; the checker
is not."*, and the inverse holds here: this generator is not a checker).

1. Run `node run.js --runs 8` (or more — BUILD-PLAN.md suggests 5-10; keep
   going if none of the first batch shows organic drift).
2. Open each `fixtures/generated/run-NN/hop-*.md` and read them. Look for:
   the base ("X of Y") present in `hop-1-researcher.md` but silently missing
   from `hop-2-summariser.md` or `hop-3-writer.md` (**denominator loss**);
   the numeric value itself changing between hops (**value drift**); the
   unit or subject changing (**unit drift**); or a hedge word present at hop
   1 ("preliminary", "small sample", "roughly") silently gone by hop 3
   (**caveat loss**).
3. Pick the strongest run. Copy its three files into `briefs/` using the
   same filenames (`hop-1-researcher.md`, `hop-2-summariser.md`,
   `hop-3-writer.md`) — these become the primary live-demo tamper surface
   (see `../FRONTEND-SPEC.md` Zone 2).
4. Write a manifest next to it — same shape as
   `../fixtures/real-corpus/MANIFEST.md` — naming the exact hop, the exact
   corruption class, and quoting the before/after text.
5. If none of the runs show organic corruption, that is itself a valid,
   reportable outcome — say so rather than manufacturing one. The real
   corpus fixture (`../fixtures/real-corpus/`) does not depend on this
   pipeline succeeding.

## Design notes — why the prompts read the way they do

`lib/prompts.js` is short and worth reading in full before changing it.
Three rules are load-bearing:

1. **No claim ID, no UUID, ever crosses a hop boundary.** Each prompt passes
   only the previous hop's plain text forward. This is BATON's whole point
   (BUILD-PLAN.md, "Do not align on the number... downstream carries no
   ID") — a swarm that quietly re-attached an identifier would stop being
   evidence for anything.
2. **The summariser and writer prompts say "paraphrase" / "in your own
   words" / "do not copy verbatim" — never "corrupt," "introduce an error,"
   or anything adjacent.** `test/pipeline.test.js` asserts this with a
   regression test, specifically so a later edit optimizing for "a more
   reliable demo" can't quietly turn this into theatre.
3. **The researcher prompt requires an explicit base ("X of Y"), not a bare
   rate.** A claim with no denominator to begin with can't demonstrate
   losing one.

## Why the briefs are exactly the model's text

`lib/save.js` writes each hop's raw text, trimmed, with a trailing newline —
nothing else. No frontmatter, no JSON, no added heading, no metadata
comment. A judge opening `briefs/hop-2-summariser.md` in a text editor during
the pitch needs to see a document, not a data structure with a schema — see
`../FRONTEND-SPEC.md` Zone 2: *"If this looks like a config panel, editing it
reads as editing config."*

## File naming — one discrepancy to be aware of

This package writes `hop-1-researcher.md` / `hop-2-summariser.md` /
`hop-3-writer.md`, per the explicit brief this package was built against.
`../FRONTEND-SPEC.md`'s example request body instead shows
`briefs/01-researcher.md` / `briefs/02-summariser.md` /
`briefs/03-writer.md`. Whoever wires the `POST /check` endpoint to read these
files should reconcile the two — either rename on read, or align the
naming convention across `swarm/` and the frontend spec before the demo.

## Testing

```bash
cd swarm
npm test          # = node --test test/*.test.js — offline, no key needed, 9/9 passing
```

Covers: hop chaining is real (not three independent calls), no identifier
crosses a hop, the prompts never instruct corruption, scenario selection is
deterministic under a seeded RNG, `writeBriefs` never wraps or adds structure
to the model's text, credential detection is correct, and the CLI's
no-credential error path prints guidance instead of a stack trace. It cannot
and does not test anything about real model behavior — that requires an
actual run against a live key.
