# QUORUM — build plan

**Team 14 · Track 02 (Agentic Web, Swarms & Harnesses) · deadline 2026-08-29 09:00**

---

## Context

Jury round 1 killed HOOKPRINT as *"vague, no real-world use case."* The mentor's follow-up was the same note: pick a **particular use case** and show explicitly why it beats the alternatives.

QUORUM is that pivot. It answers RFB-02 / Track 02's own stated test verbatim:

> *"Give the system a real job, involving more than one agent. Then leave it alone. Does the handoff hold? Does it still work?"*

**The use case: AI research reports that people make decisions on.** Research agent gathers → synthesiser condenses → writer produces the deliverable → somebody acts on it. The number that arrives is not always the number that was found, and it looks *better* after each hop, which is why nobody catches it.

**Scoring rubric (from the ideation record):** 30% usefulness · 25% execution · **20% new-internet leverage** · 15% technical depth · 10% originality. The 20% leverage axis is what the on-chain stake is for — it is not decoration.

**Trust boundary (added after an independent threat-model pass — see `CONTENT-BRIEF.md` §0):** QUORUM does not claim a claim is *true*. It claims a claim's *meaning survived the handoff*, or names exactly where it didn't. Say this before anyone can ask "does this prove it's true?" — it turns the hardest possible question into a rehearsed line.

---

## The one design decision everything follows from

**Do not align on the number.**

Value drift is a corruption class, so any aligner requiring numeric agreement makes its own headline class unreachable — a drifted claim silently becomes "unmatched" instead of "value drift."

- **Version (i)** — claim IDs mandatory and copied downstream, then string-compare. This is a checksum. A judge says *"so it's a checksum?"* and the pitch dies in that sentence. **DO NOT BUILD THIS.**
- **Version (ii)** — downstream carries **no ID**; we re-identify a claim the next agent **rewrote in its own words** and still catch the drift. **THIS IS THE PRODUCT.**

---

## Demo evidence — real, found, on disk

Verified in `D:\Tenori_Hack\ideation\` before QUORUM existed. Judges can open the files themselves.

**Corrected twice — once on 2026-08-29 after an inflated hop count was caught, and again the same night after an adversarial pass (`LOKI-ATTACK.md` §1) proved the remaining framing was still wrong. Both corrections came from re-reading primary data, not from re-reading a summary. That is the discipline this project exists to enforce, applied to the project's own pitch.**

### The catchable instance — one agent, two restatements, fifteen lines apart

**This is the demo. It is entirely inside one file, written by one agent, in one sitting.**

| Position | File | Text | State |
|---|---|---|---|
| Base stated | `zeus-confidence-routing.md:158` | "**2 of 252 dispatch records** carry a confidence value (0.79%)" | base present — rate *and* its denominator |
| Restated, 15 lines later | `zeus-confidence-routing.md:173` | "**Kevin's fleet reports 0.79%**" | **base gone** |
| Consequence | same file, same passage | the now-baseless 0.79% is compared against published figures of "50–91%" and declared *"two orders of magnitude below"* | a comparison only valid if the bases are commensurable — they are not |

**Say it exactly this way:** *"One agent. One document. Fifteen lines apart. He stated the base, then dropped it, then compared the baseless number against a published range and drew a conclusion from it. There was no handoff to blame — and it still happened."*

**Why that is the stronger claim, not the weaker one.** A corruption that needs a handoff to occur can be fixed by being careful at handoffs. This one occurred **without a handoff at all**, inside a single author's successive rewrites of himself. The failure mode is not "agents are careless when passing"; it is that *a restatement is a lossy operation regardless of who performs it* — which is why the fix has to be mechanical rather than procedural. That is a broader and more defensible claim than the three-hop story it replaces.

### What `raven-deep-trust.md` actually is in this fixture: a concurrent sibling, not an origin

`raven-deep-trust.md:81` ("Kevin's fleet: **0.79%** — 2 of 252 dispatches") is in the fixture, and it is **not hop 1 and not an origin.** `[COMPUTED 2026-08-29, re-derived from primary data for this document]` — deduplicating `D:\Projects\Stark-Core\state\dispatches.jsonl` on `key`, last-write-wins (**the dispatch count moves every few minutes — `node bench/recompute.js` — but the two `started_at` timestamps below are historical records and do not**), the `started_at` field reads:

```
zeus    2026-08-27T13:52:26   completed   run_brief_chars=7548   claude-opus-5
raven   2026-08-27T13:53:28   completed   run_brief_chars=9045   claude-opus-5
```

**62.0 seconds apart. Concurrent. zeus started first.** Neither agent read the other's file; both received "2 of 252" from the same dispatch brief, and both say so in their own text (`zeus:158` — *"Kevin's measurement, carried forward"*; `raven:20` — *"the brief's figure"*). The brief itself is not in the fixture and cannot be opened by a judge.

**Do not call this a chain and do not say "three agents."** The honest description, which is also the interesting one:

> *"Two agents got the same number from the same brief a minute apart. Neither corrupted it in transit — there was no transit. The corruption is entirely inside one of them."*

**This is deliberately kept in the fixture**, because it is what makes the fixture a *test set* rather than a *highlight reel*: it contains cases QUORUM is designed to catch **and** cases QUORUM is designed to be silent on, labelled as such. See `fixtures/benchmark/` and §"The honesty benchmark" below.

### The second instance is a trust-boundary demonstration, NOT a catch

⚠️ **`2/37 = 5%` → true value `2/17 = 12%` is the class QUORUM explicitly cannot catch, and it must be presented that way.** It was never corrupted in transit: `2/37` was wrong the first time it was written and was then copied **perfectly** to four locations. `[COMPUTED]` `grep -rnE "2\s*/\s*17|2 of 17"` across `D:\Tenori_Hack\ideation\` returns hits only in the document that *corrected* it two hours later by recounting the raw data. The mentor's own threat-model review uses these exact two numbers as its textbook example of **"Threat 1 — Origin Poisoning"** (`BATON_Threat_Model_and_Security_Architecture.md:187-206`) — the class it states plainly QUORUM cannot help with.

**Run QUORUM over that chain and it says ACCEPT. The number is still wrong by a factor of two.** That is not a bug; it is the trust boundary firing exactly as specified.

**So use it — on purpose, as the honesty beat:**

> *"Here is a number in our own corpus that QUORUM passes clean, and it is wrong by a factor of two. It was wrong before the first handoff, so there was nothing for us to compare it against. That is origin truth, not handoff integrity, and we do not claim it. If you want to know which parts of a system to trust, ask it what it fails on — this is ours, and we brought the example with us."*

A judge who hears a team volunteer its own counterexample stops looking for one. This turns the single most dangerous contradiction in the pitch into the most credible thirty seconds in it.

**Third instance (real, and it is a *staleness* finding, not a transit finding):** the same numerator quoted against two different bases — "2 of 378" and "2 of 252" — **inside one document**, where that document's own line 13 already flags 252 as stale (*"brief said ~252 — it grew"*) and then uses 252 anyway 68 lines later. See prepared answer *"what if the source moved?"* below.

**Opening line:** *"We invented this corruption class from one near-miss in our own document — then found eight more inside the document that proposed the fix. Then we labelled all eight and turned them into a benchmark, so you don't have to take our word for any of it."*

---

## Scope

### IN
1. **`packages/align`** — claim minting, paraphrase realignment, four-class diff. **The depth core.** Deterministic, zero deps, no network, no LLM.
2. **`packages/sign`** — ed25519 over canonical claim bundles. *Verified working: Node built-in, 64-byte sigs, one changed field → `verify` returns `false`.*
3. **`swarm/`** — the 3-agent job writing **human-legible prose** briefs to disk.
4. **Judge-tamper surface** — they edit the prose brief with their own hands.
5. **`packages/stake`** — stake + slash, local chain primary, one testnet deploy best-effort.
6. **`ui/`** — claim DAG, one edge red.

### OUT — do not build
- Chain **anchoring** of hashes (prior analysis refused it: *"a web3-native panel is the least impressed audience for a bolted-on chain"*). Stake/slash is different — it fires on stage.
- Any LLM in the checker. Agents are models; **the checker is not.**
- Coverage beyond the four corruption classes.
- A reputation score. `ERC-8004`-shaped reputation was measured broken; four Track-02 teams are already in that cluster.

---

## Architecture

```
packages/align/     lexicon · text · quantity · contract · extract
                    mint · score · align · diff · evidence · index · report   (~1340 LOC)
packages/sign/      keys · sign · verify                                      (~120 LOC)
packages/stake/     AgentStake.sol · client                                   (~150 LOC)
swarm/              researcher · summariser · writer · briefs/*.md
ui/                 claim DAG
```

**`index.js` is the write gate, not a passive report emitter.** It wraps the Report (alignments + deltas + unaligned + dropped_claims) in a per-claim verdict: any `fail`-severity delta on a claim → `REJECT`, canonical value stated as unchanged; otherwise → `ACCEPT`, claim promoted to canonical. This is the same pipeline already scoped, restructured so the default is deny — "verification failure cannot silently become acceptance." Cheap (wraps existing output), and it's the difference between pitching "we detect drift after the fact" and "nothing corrupted becomes canonical."

**Reuse from HOOKPRINT** (`hookprint-final` branch):
- `extension/src/detectors/util.js` — `makeFinding` throwing-constructor + frozen-enum pattern → mirror in `align/contract.js`
- `extension/src/detectors/schema.js` — field-alias normalisation, "return null rather than fabricate a shape"
- `extension/src/detectors/tests/contract-assert.js` — standalone shape validator
- `CONTRACT.md`'s **`dropped[]`-with-reason receipt** → becomes QUORUM's `unaligned[]`. *Never fabricate a match to fill the table.*
- Zero-dep `node:test` setup. **Note:** the recorded `npm test` script is stale on Node 24 — use `node --test`.

---

## Build order and kill gates

| When | What | Gate |
|---|---|---|
| now → +0:35 | `lexicon` + `text` (byte index, splitters) | byte index O(n), not O(n²) |
| +0:35 → +1:20 | `quantity.js` | **HARD TIMEBOX** — biggest overrun risk |
| +1:20 → +1:50 | `contract` + `extract` + `mint` | origins and candidates share ONE parser |
| +1:50 → +2:30 | `score` + `align` | — |
| **+2:30** | **CHECKPOINT** | **<4 of 5 paraphrase forms align → take fallback B (monotonic DP), do NOT debug weights** |
| +2:30 → +3:20 | `diff.js` — **denominator first** | it is the differentiator |
| +3:20 → +4:00 | `evidence` + determinism + no-network tests | test #17 must pass |
| +4:00 → +6:00 | swarm pipeline + signing integration | end-to-end green |
| +6:00 → +7:30 | stake/slash on local chain | — |
| +7:30 → +9:00 | UI + tamper surface | — |
| **+9:00** | **RECORD THE DEMO VIDEO** | **non-negotiable, whatever state it is in** |
| then | rehearse timed, sleep | pitch is 180s |

**Fallback ladder** (take at the 2:30 checkpoint without debugging weights):
- **B — monotonic DP alignment** (50 LOC, 20 min). Briefs preserve claim order; forbidding crossing alignments turns a weak local signal into a strong global one. *Recommended upgrade regardless.*
- **A — anchor minting** (30 min). Mint 2–3 rare-token anchors per claim against the whole source file.
- **C — honesty floor** (10 min, never cut). Restrict to the numerically-anchored subset, report the rest in `unaligned` with a stated reason.

---

## Allocation

| Who | Owns | Status |
|---|---|---|
| **edith** (agent, `baton`) | Froze the claim/delta contract + module boundaries. **DONE — 37/37 green, committed (`48e0a7f`).** Now: `index.js` write-gate (ACCEPT/REJECT wrapper) + integration. | ✅ contract / 🔄 gate |
| **cyborg** (agent, `baton`) | `quantity.js` → `score.js` → `align.js`. The depth core. | ✅ **DONE — 100/100 green, committed (`986fddf`).** |
| **cyborg #2** (agent, `baton-diff`) | `diff.js` (denominator first) + the test suite. First attempt died on an opus session rate limit before writing logic. | 🔄 redispatched, sonnet/xhigh |
| **Kevin** | The 2:30 checkpoint call, the swarm pipeline, and the demo. Owns every go/no-go. | — |
| **3rd-yr A** (`baton-swarm`) | `swarm/` prose briefs + the tamper surface. Must render as **prose, not JSON** — see risks. | idle, worktree seeded |
| **3rd-yr B** (`baton-ui`) | UI: claim DAG, one edge red. | idle, worktree seeded |
| **Non-technical** | **Fix the submission blurb — it still says FEASIBLE on the public registry (30 seconds).** Then: wallet + faucet, 180s script, timed rehearsal. | — |

⚠️ Every agent dispatch **checkpoints to disk**. Fleet history: 40% of dispatches die, and two dispatches on this exact build already died mid-run on an opus-5 session rate limit — `edith` and `cyborg` are now configured `model: sonnet, effort: xhigh` globally (`~/.claude/agents/`) to reduce recurrence.

⚠️ **One-agent-per-worktree is a hard rule now, not a preference.** edith's own commit flagged that two streams briefly wrote into the same `baton` working tree by luck of timing, not by design — this is why `diff.js`, `swarm/`, `ui/`, and `stake/` each got a dedicated worktree (`baton-diff`, `baton-swarm`, `baton-ui`, `baton-stake`).

---

## Demo — 180 seconds

A previous design measured 217s against a 180s slot. Time it out loud.

| t | Beat |
|---|---|
| 0–15s | *"An agent wrote down a number with its base. Fifteen lines later, the same agent restated it without the base — then compared the bare number to a published range and drew a conclusion. Nobody handed anything to anybody. Watch."* Real file on screen, two highlighted lines. No new vocabulary. |
| 15–40s | Run the gate on the **real ideation corpus**. `REJECT · denominator_loss`, naming the exact line. It works, offline, in front of them. |
| 40–70s | **The benchmark.** *"That is one instance. Here are twelve, all labelled, all from our own documents, with ground truth recomputed from the raw data — not from the documents."* Run `node bench/run.js` → what appears: **precision 100.0% · recall 33.3% · false-positive rate 0.0% · F1 50.0%**, over 5 scored instances (3 corrupt, 2 clean). **This is the beat nobody else in the room has.** ⚠️ **Say the denominator out loud in the same breath — "five instances, and the false-positive denominator is one"** — because the next slide is the one where we volunteer the bad number, and getting there first is the whole point. |
| 70–110s | **Judge edits the prose brief with their own hands.** Not JSON — prose. Gate returns **REJECT** naming hop and class. *"It rewrote it in its own words and carried no ID. We re-identified it anyway — and canonical state is unchanged."* |
| 110–140s | **The honest limit, volunteered.** *"Now watch it pass something that is wrong."* Show the `2/37` origin-poisoning row → **ACCEPT**, and say why: origin truth is not handoff integrity, and we do not claim it. |
| 140–165s | Tamper one byte of the signed bundle → signature **refuses**. Stake slash shown as **optional accountability layer**, stated as such (see prepared answers). |
| 165–180s | *"in-toto signs the file. We sign the claim inside it. We don't claim it's true — we claim it survived the handoff, or we name exactly where it didn't. You can run our checker with the network off, and you can run our benchmark yourself."* |

**Timing note:** the benchmark beat (40–70s) is new and displaces 30s. It is worth it — it is the only beat that converts a demo into a measurement, and finding #4 of `LOKI-ATTACK.md` is that a gate with no measured false-positive rate is not a gate. **If the run is over 180s in rehearsal, cut the stake beat to five seconds (one sentence, no screen time), not the benchmark.**

⭐ **The optional 8-second add-on that is probably worth more than any other 8 seconds in this demo — the `--raw` beat.** After the headline numbers land, run `node bench/run.js --raw` and let the room watch the false-positive rate go from **0% to 100%**, then say:

> *"Same gate, same instances. The only thing that changed is that we stopped telling it which clause to look at. At document granularity we fail, and we know the three reasons — the extractor picks a different quantity on each side of the pair, it binds a percentage to the wrong name across a table delimiter, and it can't match `5%` to `2 out of 37` because one is a rate and one is a count. That flag ships in the repo. We could have not written it."*

**Why this is worth the risk.** Every other team's demo shows the number that flatters them. This is the only beat available tonight where a team **runs the command that makes their own product look bad, on stage, unprompted** — and it costs nothing, because the claim-level number is still real and the failure is diagnosed rather than hand-waved. It converts "trust our metric" into "here is our metric's exact boundary," which is the same move the trust-boundary beat (110–140s) makes and the reason that beat works. **If the timing is tight, this and the origin-poisoning beat are making the same argument — run whichever the room has more appetite for, not both.** Do not cut the headline benchmark for it.

---

## Known attacks, with prepared answers

| Attack | Answer |
|---|---|
| *"So it's a checksum?"* | Only under version (i). We carry **no ID downstream** and realign a paraphrase. |
| *"Why not in-toto / SLSA / Sigstore?"* | **Say it first.** Those are provenance over **artifacts** — file in, file out, hash both. in-toto will happily attest a report whose 44 became 60. We do provenance over the **claim inside** the artifact. |
| *"What stops an agent writing a predicate its own output passes?"* | **Separation of duties** — predicates come from the task spec, authored ahead of the work, never from the worker. |
| *"Why does this need a chain?"* | It doesn't, for signing. The chain's only job is making a **third-party** agent financially liable for a false claim. |
| *"Is the signature real?"* | Tamper one byte on stage → it refuses. *A signature nobody verifies is a prop, and this panel detects props.* |
| Ordering penalty (4 Track-02 trust teams) | *"Three teams tonight will say 'verified.' Ours is the one you can check with the network off."* |
| *"Does this prove the claim is TRUE?"* | **No — and that's deliberate.** QUORUM protects handoff integrity, not origin truth. An origin agent can be poisoned while every downstream agent stays perfectly consistent; we say so up front rather than let a judge find it. |
| *"What about replay attacks, stolen keys, two orgs signing conflicting versions?"* | **Named, not built tonight.** Equivocation detection, replay protection, and key rotation are real problems for a multi-writer, multi-org system — this build has one proposer per hop, so they don't bite yet. We know exactly what we didn't defend against, which is rarer at this table than a clean demo. |
| *"So what happens to a rejected claim?"* | It never touches canonical state. The gate defaults to reject — there is no path where an unresolved or ambiguous **aligned** claim quietly proceeds as if it were clean. (Scope of "covered" is stated precisely in the next row — do not overstate it.) |
| ⭐ *"If my summariser writes a number I never gave it, what does your gate say?"* **(the hardest question in the room — LOKI §2)** | **"Nothing, by default — and that is a deliberate scope line, not a gap we missed."** The gate returns a verdict for every claim it could align. A downstream number with **no origin to align to** is not a corrupted restatement — it is an *invention*, a different failure mode — and it lands in `unaligned[]`, our honesty receipt. We keep those separate on purpose: *"we refused to guess"* and *"we rejected a proposal"* are different findings, and conflating them would be a real bug. **What we added after our own red-team caught this:** `gate()` now reports a **coverage number** — what fraction of the quantified claims in this document the gate actually had an opinion about — so "covered" is a printed figure, never an implication. And `--strict` turns every unaligned quantified claim into an explicit `REJECT · no_origin` for pipelines that want invention gated too. **QUORUM gates the matched subset of the document, states that subset as a number, and lets you make it mandatory.** |
| ⭐ *"Your best moment is a human editing a file. Where's the second agent? The track says leave it alone."* **(LOKI §6)** | **Two different questions, and we answer both with different evidence — don't let them blur.** *"Does the handoff hold when you leave it alone?"* was already answered before QUORUM existed: we left a real 18-agent fleet alone for 50 days, and the corpus we demo on is what came back. A base vanished inside one agent's own restatements; a wrong denominator propagated to four locations unchallenged. **That is the "leave it alone" result, and it is on disk, dated, and older than this project.** The judge's keyboard answers a *different* question — *"is your checker real, or tuned to the one example you brought?"* — which is why we hand it to them. A live run at 09:00 gives you one sample with us watching. The corpus gives you 50 days with nobody watching. |
| ⭐ *"What does your gate do to the behaviour of the thing it gates?"* **(Goodhart — LOKI §7)** | **"It teaches the summariser to stop summarising, and we know it."** Deployed in-loop against an optimising writer, paraphrase is the only thing that costs — verbatim copy maximises every channel we score and trips nothing. Every gate ever built has this shape. Three things we do about it: **(1)** QUORUM is scoped as a **release gate, not a training signal** — it sits between an agent and canonical state, never inside a reward loop. **(2)** Verbatim copy is a *degenerate pass, not a silent one*: identical-text restatements are visible in the report, so "the writer stopped writing" is detectable rather than rewarded. **(3)** The caveat check is the sharp edge — caveats match by *kind* in a ±1-sentence window, so **emitting the token satisfies it**; a writer that learns to append "(preliminary)" while stripping the substance passes clean. That is a real, unfixed limitation of a non-semantic checker and it is the price of having no model in the checking path. **We would rather name the exploit than pretend a frozen term table understands meaning.** |
| ⭐ *"Your stake fires on 'differed,' but you're calling it 'proved false.' Who pays when the origin was the liar?"* **(LOKI §8)** | **The pitch line was wrong and we changed it. QUORUM never proves a claim false — it proves two statements differ, and it has no mechanism to say which side is right.** That is the trust boundary, and a slashing rule that ignores it moves money against whichever agent restated a poisoned number honestly — or against the one who *corrected* it. There is also a griefing shape: a downstream agent authors the restatement **and** triggers the delta, so one party controls both halves. **Therefore: staking is optional and subordinate to the claim-integrity mechanism** — the mentor's own threat-model review says exactly this at line 760, and we now follow it. What the stake actually proves is **accountability, not truth**: an identifiable party put value behind an attestation, and a dispute is recorded on-chain with the class and the claim id. Arbitration of *who was right* is a human or a separate oracle. **We are not shipping an automatic slash wired to a `gate()` verdict, and the demo says so out loud.** |
| ⭐ *"What if the source moved after you minted the evidence pointer?"* **(staleness — LOKI §9)** | **"Then we say 'valid' and we are wrong, and it is the dominant failure mode in our own corpus."** We store a byte-hash of the source file at mint time and **nothing re-verifies it at check time** — the pointer is minted once and trusted forever. This is **Threat 11 — Evidence Drift** in our own threat-model review, documented as future work before a judge asked. Three figures from our corpus (`node bench/recompute.js` re-checks and exits `1` on drift): dispatch records `252 → 378 →` **live recomputation `309 → 311 → 313 → 315` inside roughly one day**; a completion rate `2/37 → 2/17 → 3/22`; a fleet age written as *"six months"* eleven times against a real span of **50 days**. **And the sharpest version of this answer, which is worth memorising verbatim: the dispatch count in this very document read `311` while `CONTENT-BRIEF.md` and `PROJECT-REFERENCE.md` also read `311` — all three perfectly consistent with each other, all three wrong — until `recompute.js` was run. We corrected it to `313`, and the script reported `315` in the same session before the edit was committed. No comparison of restatements finds that, ever. Only recomputation does, and that is a different product from the one we are showing you.** **Every one of those was caught by recomputing from the primary file, never by comparing restatements — QUORUM reports nothing on any of them, and every evidence pointer still resolves "valid."** The fix is a one-line re-hash at check time plus a `STALE_EVIDENCE` state; it is scoped, it is not built tonight, and *the reason we can tell you the exact size of the hole is that we measured it.* |
| ⭐ *"33% recall. So it misses two thirds of the corruption?"* **(the question the benchmark itself invites — answer without flinching)** | **"On this corpus, at this granularity, yes — and we'd rather you hear it from the tool than from a slide."** Three corrupt handoff rows, one caught. The two misses are not wrong answers, they are **`NO_VERDICT`** — the gate could not align the pair, so it said nothing rather than guessing. **That is the refuse-to-guess state working as designed, and it is why precision is 100% and the false-positive rate is 0%: QUORUM's failure mode is silence, not noise.** For a gate sitting in front of canonical state, a miss costs you the status quo; a false positive costs you a blocked pipeline and an engineer's afternoon. **We tuned for the failure that is cheap to be wrong about, on purpose.** And the misses have named causes — see the `--raw` answer below — not "the model didn't catch it." |
| ⭐ *"What's your false-positive rate at realistic granularity?"* / *"Isn't the focus-span annotation doing the work?"* **(the strongest attack available on this benchmark — it is in our own README before anyone asks)** | **"0% at claim level and 100% at document level, and the flag that shows you the second number is in the repo."** The fixture annotates each side with a `focus` span — the minimal claim-bearing clause — which is **the granularity the entire summarisation-faithfulness literature evaluates at**, and the fixture's `annotation_note` says so. `--raw` throws it away and feeds the whole line. Performance collapses. **The three causes, each diagnosed by running `extract.js` directly, each individually fixable, none of them "it's hard":** (1) **primary-selection disagreement** — on a line with four quantities the extractor returns `0.79%` for one side and `~100%` for the other, so the two sides are about different facts and nothing gets checked; (2) **unit mis-attachment across a delimiter** — in `friday 2/37 (5%) - edith 5/18 (28%) - ...` it binds friday's `5%` to the token `edith`, and the differ then *correctly* fires on a mislabelled pair, which is our single false positive; (3) **cross-dimension restatement** — `friday 2/37 (5%)` parses as a percent, `finished 2 jobs out of 37` parses as a count, and a percent cannot align to a count, **so this one fails in both modes.** The honest headline: **QUORUM survives lexical paraphrase and does not yet survive dimensional paraphrase.** ⚠️ **The point most worth making to a technical judge:** an alignment failure on a *clean* pair doesn't look like a false positive — it silently drops that row out of the FPR denominator. **A weak gate can report a beautiful false-positive rate for exactly the wrong reason.** Ours is 0% over a denominator of **one**. We print the `NO_VERDICT` count next to every metric so you can see that, and we say the denominator before we say the percentage — because reporting a rate without its base is `denominator_loss`, which is the corruption class our own headline example is labelled with. |
| ⭐ *"Isn't this just summarisation-faithfulness evaluation with a hash on it?"* **(prior art — LOKI Part 3, now verified)** | **"AlignScore, SummaC, QAGS, QuestEval, FactCC — yes, that is the nearest neighbourhood, and it is the right question."** The difference is what the output is *for*. Those are **evaluation instruments**: score a summary offline, report a number, research setting, model in the loop. QUORUM is a **gate**: per-claim ACCEPT/REJECT, in the pipeline, deterministic, **no model in the checking path**. Three things none of them have: a **typed corruption taxonomy** (`denominator_loss` is not a category in that literature), an explicit **refuse-to-guess state** rather than a forced score, and **verdicts you can reproduce byte-for-byte offline**. And the reason the checker must not be a model is not that offline is convenient — **a model-based checker shares the summariser's blind spot.** Faithfulness failure tracks a mid-to-late-layer circuit (r = 0.815 / 0.734, arXiv 2604.01457v3, COLM 2026) that no prompt fixes. **A checker that can hallucinate cannot be a gate.** |
| *"Your margin gate is just Fellegi–Sunter."* | **"Fellegi–Sunter (1969), and we will happily say the name first."** Probabilistic record linkage's three-way decision — link / possible-link / non-link, with a review band between thresholds — is 57 years old and it is the right ancestor for our 0.07 band. One real difference: F–S thresholds are **absolute** likelihood-ratio cuts chosen by the practitioner; ours is a **relative** margin — a match must beat *its own runner-up* by 0.07 — which needs no calibration against a labelled population to be meaningful. **Being the same shape as a 1969 result is a compliment. Being caught not knowing it is the problem, so we say it first.** |

**Never claim:** that we invented signing (GitHub ships Sigstore-backed attestations), that we invented sybil resistance, that the stake proves a claim false, that the demo is a three-agent chain, that the `2/37` figure is something QUORUM catches, or any unverified percentage.

---

## Verification

```bash
cd packages/align && node --test          # NOT `npm test` — stale script on Node 24
```

Must pass before the demo is considered real:
- **#3** value drift `44 → 60` aligns via the drift lane and yields `value_drift`, **not** `unaligned` — proves the aligner is not cheating by matching on the number
- **#4** same number, different claim does **not** cross-align
- **#10** denominator never existed → zero `denominator_loss` findings
- **#12** hoisted caveat is not reported as stripped — the likeliest false positive
- **#16** determinism: shuffle candidates, report is `deepEqual`
- **#17** module graph contains zero network imports — mechanises the pitch claim

End-to-end: run the swarm on the real ideation corpus, tamper a brief by hand, confirm the halt names the right hop and class, confirm the slash fires, confirm a one-byte tamper breaks the signature.
