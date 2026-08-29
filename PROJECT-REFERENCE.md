# QUORUM — complete project reference

**Everything about this project, in one place.** Written 2026-08-29, mid-build, with real runway on the deadline. This is a living document — the "known gaps" section at the bottom is honest about what's still open, including two adversarial passes (loki attacking, raven improving) still in flight as this was written.

> **Scope note, added during Phase 0 consolidation (2026-08-29).** This project is now developing toward the full QUORUM vision — a trust-aware AI execution router that profiles, batches, routes, executes, merges, and verifies multi-provider work — per the build plan at `C:\Users\kavin\.claude\plans\okay-then-create-an-cuddly-chipmunk.md`. The align/diff/gate engine this document describes is not being replaced; it becomes the verification layer for that router's merge step (cross-batch claim consistency checking), not the whole product. Read everything below as the state of that verification layer, not the full router.

---

## 1. What QUORUM is, in one paragraph

QUORUM is a deterministic, zero-dependency checker for multi-agent handoffs. An agent states a quantified claim; some later agent — or, as in this project's own flagship evidence, *the same agent fifteen lines further down its own document* — restates it in different words; and QUORUM re-identifies that restatement against its origin **without any claim ID ever being carried downstream**, then diffs the pair for four specific corruption classes: value drift, unit drift, denominator loss, and caveat stripping. It signs every claim with ed25519, stakes real value on agent honesty via a Solidity contract, and — as of tonight's threat-model pass — enforces explicit state transitions (propose/derive/correct/challenge/attest) instead of a generic "update" permission. Everything runs offline, with no LLM in the checking path; the agents being checked are models, the thing checking them deliberately is not.

**The trust boundary, stated once and meant to be repeated exactly:** QUORUM does not prove a claim is *true*. It proves a claim's *meaning survived the handoff*, or names precisely where it didn't. See §7.

---

## 2. Where this came from

Built for **Tenori Hack**, Track 02 (Agentic Web, Swarms & Harnesses), Team 14. The team's first submission, **HOOKPRINT** (a browser extension that detected attention-manipulation patterns in web pages), was killed in round-1 judging as *"vague, no real-world use case."* A mentor's follow-up said the same thing in different words: pick a specific, defensible use case and show explicitly why it beats the alternatives.

QUORUM is the pivot. HOOKPRINT is fully preserved — nothing was lost — on the `hookprint-final` branch and in a zip archive at `D:\Tenori_Hack_ARCHIVE\`. Several of HOOKPRINT's engineering conventions carried forward directly into QUORUM (see §4's "reuse" note).

Two escalations shaped tonight's scope:
1. Kevin consulted a mentor, who produced an independent **threat-model and security-architecture review** (`C:\Users\kavin\Downloads\BATON_Threat_Model_and_Security_Architecture.md`) — a genuinely rigorous document that reframed QUORUM from "a checker that reports drift" to "a write gate that prevents corrupted claims from becoming canonical," and specified a threat catalogue (23 named threats) with an explicit must-have / strong-bonus / future scope split.
2. The hackathon deadline was **extended** with real runway (not the original same-day crunch), which is what authorized building the "strong bonus" tier tonight instead of deferring all of it.

---

## 3. Repository map — which worktree has what

The project lives at `D:\Tenori_Hack`, with parallel work isolated into git worktrees under `.claude\worktrees\` so multiple agents could build simultaneously without colliding on the same files.

| Worktree | Branch | Contents | Status |
|---|---|---|---|
| `D:\Tenori_Hack` (root) | `main` | HOOKPRINT cleared out; `ideation/` (gitignored, the real evidence corpus); `LICENSE` | clean, pivoted |
| `.claude\worktrees\baton` | `worktree-baton` | `packages/align`, `packages/sign`; `BUILD-PLAN.md`, `CONTENT-BRIEF.md`, `FRONTEND-SPEC.md`, this file | **primary integration branch** |
| `.claude\worktrees\baton-registry` | `baton-registry` | `packages/registry` (+ copies of align/sign it was seeded with) | done, not yet merged into `baton` |
| `.claude\worktrees\baton-stake` | `baton-stake` | `packages/stake` (Solidity + client, + seeded align/sign) | done, not yet merged |
| `.claude\worktrees\baton-swarm` | `baton-swarm` | `fixtures/real-corpus/`, `swarm/` (live pipeline) | done, not yet merged |
| `.claude\worktrees\baton-ui` | `baton-ui` | `site/` (Next.js clone) | in progress — see §9 |
| `.claude\worktrees\baton-diff` | `baton-diff` | superseded — `diff.js` was built here, already merged into `baton`, worktree no longer needed | stale, safe to remove |

**Nothing is merged into `main` yet.** Each package stream is independently complete and tested inside its own worktree; final integration (copying/merging every `packages/*` directory into one tree, deduping the seeded copies, and committing to `main`) is a remaining step — see §10.

---

## 4. Architecture

```
packages/
  align/       claim minting, paraphrase realignment, four-class diff, the write gate
  sign/        ed25519 attestation over canonical claim bundles
  registry/    explicit state transitions + equivocation/replay protection (built on align + sign)
  stake/       Solidity stake/slash contract + Node client (built on sign's identity concept)
swarm/         the 3-agent demo pipeline (researcher -> summariser -> writer)
fixtures/
  real-corpus/ the actual, judge-verifiable corruption chain from D:\Tenori_Hack\ideation\
site/          Next.js clone of the UI reference (unifi.baunfire.com), structure phase done
```

**Reuse from HOOKPRINT**, carried forward deliberately: the throwing-constructor + frozen-enum pattern (`makeFinding` → `makeClaim`/`makeDelta`/etc.), the "a finding with no evidence is an accusation" discipline (HOOKPRINT's `dropped[]` → QUORUM's `unaligned[]`/`dropped_claims[]`), and the zero-dependency `node:test` convention. **Known trap, inherited and documented:** the naive `npm test` script (`node --test tests/`) is broken on Node 24 — every package's `package.json` uses `node --test tests/*.test.js` instead.

---

## 5. The core mechanism — how alignment actually works

This is the part that separates QUORUM from a checksum, so it's worth stating precisely.

**The one design decision everything follows from: do not align on the number.** A claim whose value drifted (44 → 60) must still align to its origin — the number moving *is* the finding. An aligner that requires numeric agreement makes its own headline corruption class structurally unreachable.

**Two-channel scoring**, computed per candidate-origin pair:
- **NUM** (numeric compatibility): reconciles scale (44 vs 0.44 vs "44%"), bands (hedge words like "roughly"/"nearly" widen a tolerance interval, never move the stated value), and falls to exactly 0 on a genuine dimension conflict (money can never align to a percent) or a genuine value change.
- **LEX** (lexical similarity, zero embeddings): IDF-weighted cosine over stemmed content tokens (IDF built fresh from the origin claim set each run; an unseen stem is clamped to the *median* origin IDF, not the max, so heavy paraphrase isn't punished for using rare words) + anchor-token Dice (capitalized/numeric/hyphenated tokens) + unit-term trigram similarity.
- **The value-drift lane**: when NUM is near-zero but LEX is strong (≥0.66), the pair still clears the accept threshold — this is the mechanism that makes value drift detectable instead of invisible.
- **The margin gate**: a match must beat its runner-up by ≥0.07 or it's refused as `ambiguous` — no delta is ever emitted for an ambiguous alignment; contract.js enforces this at the type level, not just by convention.

**The four corruption classes**, in `diff.js`:
1. **`value_drift`** — the number changed. Distinguishes "material" (fail) from "rounding" (note, bands overlap) from "precision_loss" (note — a vague restatement like "nearly half" for 44% is *correct*, not a corruption; a checker that flags an honest hedge as a failure is worse than useless, and there's a test enforcing this can never happen).
2. **`unit_drift`** — the subject/unit changed ("dispatches" → "agents"). Guards against false positives on mere pluralization via stemming + trigram similarity.
3. **`denominator_loss`** — **the differentiator.** Reportable *only* when the origin claim actually stated a base (`claim.denominator != null` — a missing base is never inferred from downstream text alone; the origin is the sole authority on whether one existed). Three subtypes: base dropped entirely (rate survives with no base, or just a bare count survives), base altered, or base re-attributed to a different unit. The single most important function in the whole project, `arithmeticallyConsistent()`, detects when a restated percentage is *arithmetically consistent with an altered base* — and the pitch line it produces is real code, not a slide: *"the restated percentage is arithmetically consistent with the altered base — which is exactly why it does not read as wrong on its face."*
4. **`caveat_loss`** — a qualifier ("unverified," "approximately," "preliminary") present at origin and silently absent downstream. Matched by *kind*, not exact term (origin "unverified" is satisfied by downstream "unconfirmed") — and checked in a ±1-sentence window around the restatement, so a caveat a summariser legitimately hoisted into a lead sentence isn't falsely flagged as stripped.

**The write gate** (`index.js`): wraps alignment + diff into a per-claim `ACCEPT`/`REJECT` verdict. Default-deny is enforced in code: `opts.diffFn` defaults to the real `diffClaim`, never a no-op (a no-op differ would make every aligned claim silently `ACCEPT`); an `ambiguous` alignment never reaches the differ at all and is `REJECT`ed with reason `ambiguous_alignment` before a Delta is ever constructed.

---

## 6. Package-by-package detail

### `packages/align` — 151/151 tests, `baton` worktree

| File | Role |
|---|---|
| `contract.js` | Frozen data contract. Every shape (`Claim`, `Candidate`, `Alignment`, `Delta`, `Report`) is a throwing constructor — malformed input fails loud, not silently. `DELTA_CLASSES` and `SEVERITIES` are hard-frozen enums; `subtype` is deliberately a validated free string, not frozen, so the diff logic can name new specifics without a contract change. |
| `lexicon.js` | Stopwords, hedge multipliers, vague-quantifier bands, caveat-kind term tables, dimension-conflict rules — all frozen data, no logic. |
| `text.js` | Byte-index building (one pass, not O(n²)), paragraph/sentence splitting with an abbreviation guard, tokenizing, stemming, trigram Dice. |
| `quantity.js` | Parses every quantity mention in a sentence (percent, ratio, "X of Y", hedge-composed, vague) into `{value, dimension, band, vague, precision, span}`. **Load-bearing convention, documented in its own header:** a percent's `value` is a true fraction (`0.44` for "44%"), never a 0–100 number — this is what lets `0.79% = 0.0079` and `2/252 = 0.007937` compare as numerically identical, which is the demo's own opening example. |
| `score.js` | The two-channel scorer above, plus `dimensionVeto`, `numericCompat`, `cosineIdf`, `unitSim`. |
| `align.js` | Builds the IDF table, computes the score matrix, does deterministic greedy assignment with the margin gate, and a "supporting pass" that recovers a denominator stated one sentence away from its rate. |
| `diff.js` | The four corruption classes above. |
| `extract.js` | Turns raw prose into the shared `Parsed` sentence shape — the **one hard invariant** of this whole package: origins and downstream restatements are parsed by this exact same code path, never two separate parsers, or the diff ends up comparing two parsers' opinions instead of the same parser applied twice. |
| `mint.js` | Wraps `extract.js`'s output into origin `Claim`s (with evidence pointers — file path, byte-hash of the source file, string-index span into the decoded text, and a `quote` that must exactly equal `source.slice(span.start, span.end)`) or downstream `Candidate`s. |
| `index.js` | The write gate (§5). |
| `report.js` | Plain-text terminal rendering of a gate result — the demo's actual on-screen output. |

**Verified against real data, not just synthetic fixtures:** `extract.js`/`mint.js`'s test suite runs against the actual files in `D:\Tenori_Hack\ideation\` (`raven-deep-trust.md`, `zeus-confidence-routing.md`) and confirms extraction succeeds on real prose, not just hand-built strings.

**One documented edge case, out of scope, not hidden:** `text.js`'s sentence splitter (frozen) doesn't treat a markdown `**` immediately after a sentence-final period as a valid boundary, so one heavily-bolded blockquote in `zeus-confidence-routing.md` merges into one long "sentence" whose primary quantity resolves to a different number than the 0.79% embedded inside it. Found while testing against real data, not invented — a plain-prose-vs-markdown parser limitation, not a bug in the checking logic itself.

### `packages/sign` — 11/11 tests, `baton` worktree

Ed25519 signing/verification, `node:crypto` only, zero third-party dependencies.

| File | Role |
|---|---|
| `canonicalize.js` | Recursively sorts object keys before signing (arrays keep order — order is semantic there) so two content-identical bundles built in different key order produce byte-identical signatures. Verified directly: two objects with the same content, different construction order, produce the exact same signature bytes. |
| `keys.js` | `generateIdentity()` → `{publicKey, privateKey, keyId}`. `keyId` is `sha256(publicKey)` truncated to 16 hex chars — a pure function of the key, never independently settable (this exact property is what a later bug in `packages/registry` depended on, see below). |
| `sign.js` / `verify.js` | `signBundle(bundle, privateKey, publicKey)` and `verifyBundle(bundle, signature, publicKey) -> boolean`. `verifyBundle` never throws — a malformed or tampered input returns `false`, so no caller needs a try/catch around "is this genuine." |

**The demo beat this enables:** tamper one byte of a signed bundle on stage → `verifyBundle` returns `false`, live, checkable.

### `packages/registry` — 76/76 tests, `baton-registry` worktree, built against the threat-model doc's §4/§10/§11

| File | Role |
|---|---|
| `transitions.js` | Explicit state-transition vocabulary (`PROPOSE_UPDATE`, `DERIVE`, `CORRECT`, `CHALLENGE`, `ATTEST`) replacing an implicit generic "update." `PROPOSE_UPDATE` is the only path that reaches the real `gate()`. `DERIVE` checks a derived claim's arithmetic against its declared parents instead of diffing it against a single origin — this is what stops QUORUM from becoming, in the threat doc's words, "an everything-must-look-identical validator." `CHALLENGE`/`ATTEST` produce a third canonical state (`CHALLENGED`/`ATTESTED`) distinct from `ACCEPT`/`REJECT`. `applyProposal` re-validates every incoming proposal through `makeProposal` rather than trusting a hand-built object's `type` string — proven by a test that a malformed proposal is rejected naming its actual missing field, not silently dispatched. |
| `equivocation.js` | Detects a signer producing two differently-signed, conflicting statements about the same claim+version. Per the threat doc: both signed statements are preserved as evidence, never silently resolved to one. |
| `replay.js` | Rejects a reused nonce, a stale timestamp, or an out-of-order version. Ordering authority is version/parentHash, **not** timestamp alone — clocks drift, the threat doc is explicit about this. |
| `signedBundle.js` | Binds `claimId`/`version`/`parentHash`/`issuer`/`nonce`/`issuedAt` *into* what gets canonicalized and signed (wraps `packages/sign`, doesn't reimplement it), so replay/equivocation checks have real, tamper-evident fields to inspect. |

**A real security bug was found and fixed here tonight**, not just documented: `signedBundle.js`'s `keyIdOfSigned()` originally trusted an optional caller-supplied `.keyId` field instead of always deriving it from `.publicKey`. Since `keyId` has no legitimate reason to diverge from `keyIdOf(publicKey)`, this let a single signer equivocate — sign two conflicting claims — while forging two different `keyId` labels, defeating `equivocation.js`'s "same signer" check. Fixed to always derive; regression-tested in both `signedBundle.test.js` and `equivocation.test.js`.

**Explicitly not built, named not hidden:** persistent storage (the equivocation/nonce stores are process-local `Map`/`Set`, gone on restart), `parentHash` chain validation (shape-checked, not walked), cross-machine/cross-org reconciliation.

### `packages/stake` — 13/13 tests (Hardhat), `baton-stake` worktree

`AgentStake.sol` — a minimal stake/slash contract. An agent stakes ETH; a designated arbiter (the deployer, standing in for "the QUORUM checker's verdict" — a named, single-arbiter limitation for the hackathon demo, not a hidden one) can slash a specific amount, citing a `claimId` and `reasonClass`, emitting a `Slashed` event. Reentrancy-guarded, access-controlled (`onlyArbiter`), tested for stake/slash/unstake success and every corresponding revert path.

**Toolchain note:** Hardhat 3.x's `npx hardhat` default requires an interactive TTY for init and wasn't usable non-interactively; pinned to Hardhat 2.29 + the classic toolbox (ethers v6) instead.

**`npm run demo:local`** runs the whole thing end-to-end on a fresh in-process chain every invocation: deploy → stake 1.0 ETH → slash 0.4 ETH driven by a JSON fixture shaped like a real `Delta` → prints real before/after balances (1.0 → 0.6 ETH) and the emitted event. Re-run twice to confirm determinism.

**Testnet (bonus, not required for the demo):** a fresh wallet was generated (`0x30e18eA8900A18b28a4C174e8675ef0Cd9799eeA`) and the deploy script proven to genuinely reach Sepolia (it reverted on `insufficient funds`, confirming the RPC connection and plumbing are real) — **needs Kevin to fund this address via a faucet** before a real testnet deployment can happen. Private key lives in a gitignored `.env`, confirmed not staged.

**Named gap:** there is no ed25519-keyId → EVM-address registry yet, so a real `Delta` from `gate()` can't be wired to a slash call automatically — the JSON shape is documented (`packages/stake/README.md`) and the mapping (`class` → `reasonClass`) is enforced by `client/index.js`'s `deltaToSlashInput()`, but the identity bridge itself is future work.

### `swarm/` and `fixtures/real-corpus/` — `baton-swarm` worktree

**The primary demo fixture is real, found evidence**, not synthetic: full, byte-identical (SHA-256 verified) copies of `raven-deep-trust.md` and `zeus-confidence-routing.md` from `D:\Tenori_Hack\ideation\`, with a `MANIFEST.md` documenting the exact chain — see §8.

**A live 3-agent pipeline** (`swarm/lib/{client,prompts,pipeline,save}.js`, `swarm/run.js`) exists, fully written and unit-tested offline (9/9 passing against a stubbed model function — proving hop-chaining is real, no ID crosses a hop, and prompts genuinely instruct "paraphrase," never "corrupt"), but **has never actually run against a live model** — no `ANTHROPIC_API_KEY` was found in this environment (checked env vars, `.env` files, and the `ant` CLI). Running it for real, credential-less, surfaced and fixed one genuine bug (a missing-credential error wasn't caught by the intended `instanceof` check, so it fell through to a raw stack trace instead of a clear message) — that fix is regression-tested by spawning the actual CLI. `swarm/briefs/` is currently empty with a `README.md` explaining exactly why, rather than containing fabricated output.

---

## 7. The trust boundary and the invariants (say these, don't paraphrase them)

> **QUORUM does not claim "this claim is true." Its guarantee is narrower: it protects the integrity, provenance, and lineage of a claim as it is created, transformed, challenged, and propagated between agents.**

There are two distinct problems — **origin truth** (does the first claim agree with reality) and **handoff integrity** (did the claim survive the trip between agents unchanged). QUORUM's core is handoff integrity. An origin agent can be poisoned while every downstream agent stays perfectly self-consistent — this is stated as a scope boundary up front, not discovered by a judge.

**Named invariants, each tied to real code, not aspiration:**
- *Ambiguous claim alignment is rejected rather than guessed* — the 0.07 margin gate; `makeReport` refuses a Delta attached to an ambiguous alignment at the type level.
- *A valid signature proves attestation, not truth* — say this before anyone asks; `packages/sign` proves who signed, never whether it's correct.
- *Verification failure cannot silently become acceptance* — `gate()`'s default-deny wiring; an unresolved or ambiguous **aligned** claim has no code path to a silent `ACCEPT`. **Scope note (added after `LOKI-ATTACK.md` §2):** this invariant is true for claims the gate could align. It does not extend to a candidate with no origin — see limitation 1 below.
- *The frontend cannot determine trust state* — `FRONTEND-SPEC.md`'s hard rule: the UI calls backend endpoints and renders their response, never computes a verdict client-side.
- *Being recorded is not equivalent to being proven true* — restates the trust boundary; the registry is a record of what was claimed and what happened to it.

### The four named limitations — stated, sized, and scoped (post-`LOKI-ATTACK.md`)

**Each of these is on a slide. A limitation stated with a measured size reads as engineering; one discovered by a judge reads as a hole.**

**1 · QUORUM gates paraphrase; it is silent on invention.** The gate emits a verdict for `matched` and for `ambiguous`. It emits none for `unaligned` — and "no origin to align to" is exactly what a fabricated number looks like. The separation itself is correct and must not be collapsed: *"we refused to guess"* and *"we rejected a proposal"* are different findings, and merging them would be a real bug. What was wrong was the *pitch* implying whole-document coverage. **Fixed by making coverage a printed number** (what fraction of quantified downstream claims the gate had an opinion about) and by an opt-in `strict` mode that turns an unaligned quantified candidate into `REJECT · no_origin`. **Say: "QUORUM gates the matched subset of the document, and tells you what fraction that was."**

**2 · QUORUM never re-checks its own ground — and staleness, not drift, is this corpus's dominant failure mode.** `mint.js` stores a byte-hash of the source file; **nothing re-verifies it at check time.** The pointer is minted once and trusted forever. This is **Threat 11 — Evidence Drift** in the mentor's threat-model review, already documented as future work. Its measured size, all recomputed from `dispatches.jsonl` on 2026-08-29: dispatch records written `252` → `378`, and on live recomputation **`309 → 311 → 313 → 315` within roughly one day**; a completion rate written `2/37`, corrected to `2/17`, now **`3/22`**; a fleet age written *"six months"* eleven times against a real span of **50 days** (earliest dispatch 2026-07-10, latest 2026-08-29). **Every one was caught by recomputing from the primary file; none by comparing restatements. QUORUM reports nothing on any of them and every evidence pointer still resolves "valid."** Fix: re-hash at check time plus a `STALE_EVIDENCE` state. Scoped, not built.

> **This limitation caught this document, and then caught the correction.** The dispatch count in the line above read `311` — and read `311` in `BUILD-PLAN.md` and `CONTENT-BRIEF.md` too, **all three agreeing with each other, all three wrong** — until `bench/recompute.js` was run against the primary file. `309` in `LOKI-ATTACK.md`, `311` an hour later, `313` at the next recompute. It was corrected to `313`, **and the script reported `315` in the same session, before the correction was committed.** Measured decay rate: roughly **two per recompute**. **Therefore: do not cite the absolute count in prose. Cite the sequence and the command.** The one mechanically detectable instance of staleness in this project is the benchmark fixture, because `bench/recompute.js` exits `1` when it drifts and `--write` re-stamps it. That script is deliberately outside `packages/align`: it is fixture maintenance, **not** a claim that QUORUM re-verifies its own evidence. It does not, and that is the whole content of this limitation.

**3 · Deployed in-loop against an optimising writer, the gate teaches it to stop rewriting.** Goodhart. Paraphrase is the only thing that costs; verbatim copy maximises every channel and trips nothing. Mitigations: QUORUM is scoped as a **release gate, not a training signal** — between an agent and canonical state, never inside a reward loop — and a degenerate verbatim pass is visible in the report rather than silently rewarded. **The unfixed edge, stated plainly:** caveats match by *kind* from a frozen term table in a ±1-sentence window, so **emitting the token satisfies the check**; a writer that appends "(preliminary)" while stripping the caveat's substance passes clean. That is the price of no model in the checking path, and it was a deliberate trade.

**4 · Staking is optional and subordinate — the stake proves accountability, not truth.** QUORUM never proves a claim false; it proves two statements differ, with no mechanism to say which side is right. A slash wired directly to a delta moves money against whoever restated a poisoned number honestly, or against whoever corrected it — and because a downstream agent authors both the restatement and the trigger, one party controls both halves of a griefing shape. **Therefore no automatic slash is wired to a `gate()` verdict**, matching the threat-model review's own line 760 (*"for the hackathon, staking should remain optional and subordinate to the claim-integrity mechanism"*). What the stake does prove: an identifiable party put value behind an attestation, and a dispute is recorded with its class and claim id. Adjudication is a human or a separate oracle.

**Named and deliberately not built tonight:** multi-writer optimistic concurrency beyond what `replay.js` already checks, full cross-org registry exchange, key rotation/revocation, persistent storage for the equivocation/replay stores, evidence re-hashing at check time (limitation 2), and **origin grounding** — a depth-to-primary-data test on evidence pointers, which the threat-model review scopes as a separate trust layer (its §"optional future module: SOURCE → ORIGIN AGENT → ORIGIN GROUNDING → QUORUM") and which this project's own flagship fixture would fail, since its evidence pointers terminate in another agent's prose rather than in machine-readable primary data. **That is worth saying out loud: we ran the test on ourselves and we do not pass it yet.**

---

## 8. The demo evidence — exact, corrected, and re-verifiable

**Corrected twice, both times from primary data.** Once on 2026-08-29 after an inflated hop count was caught, and again the same night after `LOKI-ATTACK.md` §1 proved the remaining "three agents / hop 1 origin" framing was still false. What follows is the version that survived an adversarial pass.

### The catchable instance — one agent, one document, fifteen lines apart

| Position | File | Text | State |
|---|---|---|---|
| Base stated | `zeus-confidence-routing.md:158` | "**2 of 252 dispatch records** carry a confidence value (0.79%)" | rate **and** denominator present |
| Restated 15 lines later | `zeus-confidence-routing.md:173` | "**Kevin's fleet reports 0.79%**" | **base gone** |

The now-baseless rate is then compared against published figures of "50–91%" and declared "two orders of magnitude below" — valid only if the bases are commensurable, and they are not; the original denominator (252) no longer exists in the corpus at all.

**This is the whole demo, and it is entirely inside one file by one agent in one sitting.** That is the *stronger* finding, not the weaker one: a corruption that requires a handoff can be fixed by being careful at handoffs, but this one occurred with **no handoff to blame**. The failure mode is that restating a quantity is a lossy operation regardless of who performs it — which is why the fix must be mechanical rather than procedural.

### `raven-deep-trust.md:81` is a concurrent sibling, NOT hop 1 and NOT an origin

`[COMPUTED 2026-08-29 for this document, not carried forward]` — `D:\Projects\Stark-Core\state\dispatches.jsonl`, deduplicated on `key` (**313 distinct dispatches at the last recompute; this count moves — `node bench/recompute.js`**), field `started_at`:

```
zeus    2026-08-27T13:52:26   completed   run_brief_chars=7548   claude-opus-5
raven   2026-08-27T13:53:28   completed   run_brief_chars=9045   claude-opus-5
```

**62.0 seconds apart. Concurrent. zeus started first. Neither read the other's file.** Both received "2 of 252" from the same dispatch brief and both attribute it upstream in their own text (`zeus:158` *"Kevin's measurement, carried forward"*; `raven:20` *"the brief's figure"*). That brief is not in the fixture and cannot be opened by a judge.

⛔ **Therefore: this is not a chain, there is no hop 1, and the word "three" must not appear.** `fixtures/real-corpus/MANIFEST.md` was already honest about which edge is real (*"This is the exact hop 2 → hop 3 edge, not hop 1 → hop 2"*) — the overclaim lived in the documents built on top of it, and it is now removed from all three.

**raven's document stays in the fixture on purpose.** It is an independent witness that the figure was upstream of both agents, and it carries the corpus's best *staleness* instance: line 13 flags 252 as stale (*"brief said ~252 — it grew"*) and line 81 then uses 252 anyway, 68 lines later, in the same document. **QUORUM cannot see that**, because QUORUM compares an origin document to a downstream document and has no notion of a document contradicting itself — see §7's named limitations.

### Second instance: the counterexample, kept deliberately

⚠️ **`2/37 = 5%` → true `2/17 = 12%` is origin poisoning — the class QUORUM explicitly cannot catch — and it must never be presented as a catch.** It was not corrupted in transit; it was wrong when first written and then copied perfectly to four locations. The mentor's threat-model review uses these exact two numbers as its own textbook example of **"Threat 1 — Origin Poisoning"** (`BATON_Threat_Model_and_Security_Architecture.md:187-206`), noting *"if the external source itself is wrong or malicious, QUORUM cannot independently create truth."* Running QUORUM over that chain returns **ACCEPT** while the figure is still wrong by a factor of two.

**It is now the demo's honesty beat** — a counterexample the team volunteers rather than one a judge finds. A third recomputation puts the same figure at `3/21` today, which makes it simultaneously the best illustration of §7's evidence-staleness limitation.

### The eight instances are a benchmark, not an anecdote

All labelled instances are extracted to `fixtures/benchmark/instances.json` — **12 distinct checkable pairs, `B01`–`B12`** (the "eight" of the pitch comes from `loki-deep-trust.md:295-302`, which counts a group of five as one line; cite the enumeration if a judge counts) — with source location, claimed value, true value, corruption class, and how ground truth was established, **including the confirmed-clean cases**, which is what makes a false-positive rate computable. `bench/run.js` runs the real `gate()` and real `diffClaim` against them and prints precision, recall and false-positive rate. Full method and per-instance analysis: **`bench/README.md`**.

**The measured result, both conditions. Do not cite the first row alone.**

| condition | precision | recall | FPR | F1 |
|---|---|---|---|---|
| claim-level (annotated `focus` spans) | 100.0% | 33.3% | 0.0% | 50.0% |
| document-level (`--raw`, whole cited line) | 0.0% | 0.0% | 100.0% | n/a |

Scored over the 5 `handoff_integrity` rows (3 corrupt, 2 clean); `origin_truth` (5), `invention` (1) and `hard_case` (1) are reported on separate lines and never folded into the headline. **`FPR 0.0%` has a denominator of 1** — `B04`'s alignment failure removes the other clean row from the calculation rather than placing it in either bucket. State the base with the rate; omitting it is `denominator_loss`.

**The gap is three named extractor defects, not a mystery:** primary-selection disagreement on multi-quantity lines; unit mis-attachment across a table delimiter (the single false positive — the differ was right, the pair it was handed was mislabelled); and cross-dimension restatement (`5%` vs `2 of 37`), which fails in **both** modes and is the honest limit on *"survives paraphrase."* **QUORUM survives lexical paraphrase; it does not yet survive dimensional paraphrase.**

**Opening line for the pitch:** *"We invented this corruption class from one near-miss in our own document — then found more of it inside the document that proposed the fix. We labelled it, recomputed ground truth from the raw data, and turned it into a benchmark — so you don't have to take our word for any of it. It reports zero false positives at claim level and a hundred percent at document level, and we ship the flag that shows you the second one."*

**The demo's judge-tamper beat, correctly scoped:** the judge edits a real, human-legible prose document with their own hands — not JSON, not a form — and watches the gate return `REJECT`, naming the hop and class. **This beat answers "is your checker real, or tuned to the one example you brought?" — it does not answer "does the handoff hold when left alone."** That second question is answered by the corpus itself, which is 50 days of unsupervised fleet output that nobody was watching. Keep the two claims separate; conflating them is what produced the Track-02 contradiction `LOKI-ATTACK.md` §6 caught.

---

## 9. Frontend — current state, honestly

**Structure phase:** done. A Next.js 16 (Turbopack) clone of `https://unifi.baunfire.com/` exists at `.claude\worktrees\baton-ui\site\`, built from the scrape at `C:\Users\kavin\Downloads\page_content (1)\`. Real section order and real copy (hero → vision → history/timeline → hexagon mosaic → future/team slider → partnerships → online → footer), 8+ purpose-built components, 3 Swiper carousel instances wired against the vendored CSS's real class contracts. Builds clean, lints clean, typechecks clean, serves real content (confirmed via HTTP request: title tag reads "Unifi Protocol → Blockchain Solutions").

**Motion/interaction phase:** in progress as of this writing. Kevin's own assessment: structurally ~40% there — no parallax, no smooth-scroll, no real scroll-triggered animation matching the reference. A second `friday` pass is underway, specifically instructed to read the reference site's *actual* interaction code (`assets/js/index.js` in the scrape — the site's real GSAP ScrollTrigger/ScrollSmoother/SplitText configuration) and port its real parameters, rather than approximating generic scroll-reveals.

**Visual verification gap:** the Chrome browser extension has been disconnected in this environment for both the structure-phase and (as of dispatch) the motion-phase agent — so "matches the reference" has been a code-level claim (real copy, real structure, real class contracts) rather than an actually-observed visual comparison. This needs closing — either the extension connects, or Kevin does the side-by-side manually.

**Explicitly deferred, by Kevin's own instruction:** content changes (swapping the reference site's copy/branding for QUORUM's) are a separate, later phase — not started, not to be started until explicitly requested.

---

## 10. What's still open right now

As of this document being written, two things are actively running:
1. **`loki` is attacking the whole project** — the mechanism, every test suite (re-run independently, not trusted from self-reports), the demo evidence (re-verified from primary sources), the threat-model implementation, the stake contract, and the scope-cut decisions. Findings land in `LOKI-ATTACK.md` in this worktree.
2. **`friday` is adding real motion fidelity to the UI** per §9.

**Queued next:** once loki's attack lands, `raven` is dispatched to take every finding and drive concrete improvements — not just patch defects, but push the whole submission toward "hackathon-winning," per Kevin's explicit instruction.

**Also still open, not yet scheduled:**
- **Final integration.** Every `packages/*` stream is independently complete and tested in its own worktree, but nothing has been merged into one tree on `main` yet. The seeded duplicate copies of `align`/`sign` inside `baton-registry` and `baton-stake` need deduping against the canonical versions in `baton` before a final merge.
- **The swarm pipeline has never run against a live model** — needs an `ANTHROPIC_API_KEY` to generate a fresh, organically-corrupted second fixture (the real-corpus fixture from §8 does not depend on this and stands on its own).
- **Sepolia testnet deployment** is blocked purely on funding the generated wallet address (§6).
- **UI visual verification** is blocked on the Chrome extension reconnecting, or a manual side-by-side from Kevin.
- **Stale worktree cleanup:** `baton-diff` is fully superseded (merged into `baton`) and safe to remove with `git worktree remove --force`.

---

## 11. How to run everything

```bash
# align (contract, quantity, score, align, diff, gate, extract, mint)
cd D:\Tenori_Hack\.claude\worktrees\baton\packages\align
node --test tests/*.test.js          # 151/151 — NEVER `npm test` or `node --test tests/`, both broken on Node 24

# sign
cd D:\Tenori_Hack\.claude\worktrees\baton\packages\sign
node --test tests/*.test.js          # 11/11

# registry
cd D:\Tenori_Hack\.claude\worktrees\baton-registry\packages\registry
node --test tests/*.test.js          # 76/76

# stake
cd D:\Tenori_Hack\.claude\worktrees\baton-stake\packages\stake
npx hardhat test                     # 13/13
npm run demo:local                   # real end-to-end stake -> slash on a fresh local chain

# swarm (offline tests only — no live model calls without ANTHROPIC_API_KEY)
cd D:\Tenori_Hack\.claude\worktrees\baton-swarm\swarm
npm test                             # 9/9 + the CLI regression test

# UI
cd D:\Tenori_Hack\.claude\worktrees\baton-ui\site
npm run dev                          # http://localhost:3000
npm run build                        # production build check
```

---

## 12. Other documents, and what each is for

| File | Location | Purpose |
|---|---|---|
| `BUILD-PLAN.md` | `baton` (seeded into every worktree) | The engineering build plan: scope, kill gates, allocation, the 180-second demo script, prepared attack-answers. |
| `CONTENT-BRIEF.md` | `baton` (seeded everywhere) | Raw material for generating pitch/website copy — one-liners, the trust boundary, comparisons table, explicit "don't invent statistics" guardrail. |
| `FRONTEND-SPEC.md` | `baton` (seeded everywhere) | The UI spec: theme rules (no dashboard, no idle animation, one accent color reserved for corruption), layout zones, the exact API contract (`/check`, `/sign`, `/verify`, `/slash`) the frontend calls against. |
| `PROJECT-REFERENCE.md` | `baton` | This file. |
| `LOKI-ATTACK.md` | `baton` (pending) | loki's adversarial findings against the whole project, once complete. |
| `C:\Users\kavin\Downloads\BATON_Threat_Model_and_Security_Architecture.md` | outside the repo | The mentor's independent threat-model review — the primary spec `packages/registry` was built against. |
