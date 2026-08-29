# QUORUM — content brief (feed this to ChatGPT for website/pitch copy)

This document is raw material, not finished copy. It exists so an LLM (or a person) can generate landing-page copy, a pitch deck, or a one-pager for QUORUM without re-deriving the reasoning from scratch. Everything below is either a verified fact, a direct quote from the project's own research, or a deliberately labeled recommendation.

**Instruction for whoever prompts ChatGPT with this file:** ask for website copy / pitch deck text that draws ONLY from the facts and quotes below. Do not let it invent statistics, comparisons, or claims not present here — the project's own history (see "Failure modes to avoid") shows exactly what happens when an unverified number ships.

---

## 0. The trust boundary — say this before anyone can ask

**QUORUM does not claim "this claim is true."** Its guarantee is narrower and stronger for being narrower:

> **QUORUM protects the integrity, provenance, and lineage of a claim as it is created, transformed, challenged, and propagated between agents.**

There are two distinct problems: **origin truth** (does the first claim agree with reality) and **handoff integrity** (did the claim survive the trip between agents without silently changing meaning). **QUORUM's core is handoff integrity.** An origin agent can be poisoned while every downstream agent stays perfectly self-consistent — QUORUM states this as a scope boundary, not a hidden gap, because a judge who spots an unstated limitation scores it as a failure; a limitation stated up front scores as rigor.

**This is now the answer to the single hardest question in the room:**
> *"Does this prove the claim is true?"* — "No. We prove it survived the handoff unchanged, or we prove exactly where it didn't. Origin truth is a separate, harder problem — the reason we don't oversell it is the same reason you should trust the part we do claim."

## 0.1 QUORUM is a gate, not an autopsy

Reframe the mechanism as **prevention, not post-hoc reporting.** A claim is `PROPOSED`; QUORUM's gate returns `ACCEPT` or `REJECT`; only an accepted claim becomes **canonical**. A rejected proposal never silently overwrites canonical state — the response names the class, the hop, and states the canonical value is unchanged.

This is a strictly stronger product claim than "we detected drift after it happened," and it costs almost nothing extra to build: it's the same alignment + diff pipeline, wrapped with one rule — *any `fail`-severity delta on a claim blocks that claim from becoming canonical.* Everything already scoped (alignment, the four-class diff, signing) becomes the gate's decision logic rather than a report nobody has to act on.

## 0.2 Security invariants — cite these by number, they read as independently verified

A second engineering pass (an independent threat-model review, not written to fit the pitch) converged on the same design in different language, which is itself evidence the design is sound rather than merely convenient. Invariants **already satisfied by the frozen contract and the built core:**

- **"Ambiguous claim alignment is rejected rather than guessed."** — the margin gate (§ elsewhere in this brief): a match within 0.07 of its runner-up is refused, not resolved by best-effort.
- **"A valid signature proves attestation, not truth."** — say this explicitly whenever signing comes up; it pre-empts the follow-up question instead of waiting to be caught by it.
- **"Verification failure cannot silently become acceptance."** — the gate (§0.1) defaults to `REJECT`; there is no code path where an unresolved or ambiguous **aligned** claim proceeds as if it were clean. ⚠️ **Scope this precisely in copy — see §0.3.** The invariant holds for claims the gate could align. It does not extend to a downstream number with no origin at all.
- **"The frontend cannot determine trust state."** — FRONTEND-SPEC.md already requires the frontend to call the backend and render its response, never compute a verdict client-side.
- **"Being recorded is not equivalent to being proven true."** — restates §0's trust boundary; the registry (or in the hackathon build, the check output) is a record of what was claimed and what happened to it, not a truth oracle.

**Named and deliberately NOT built tonight — say so on a "what's next" slide, don't hide it:** multi-writer optimistic concurrency (two agents proposing against the same claim version simultaneously), replay protection (nonce/expiry on signed packages), equivocation detection (the same signer producing two different values for the same version), and key rotation/revocation. A hackathon build with a single proposer per hop genuinely does not need these — but naming the exact attacks not defended against, and why, reads as maturity. Compare: zero competing Track 02 teams in this hackathon's own field notes name a single specific attack their system doesn't defend against.

## 0.3 The three named limitations — put these ON a slide, do not wait to be asked

These came out of an adversarial pass against the project's own concept (`LOKI-ATTACK.md`). Each one is real, each is stated with its size, and each has a scoped fix that is deliberately not built tonight. **A limitation stated with a measured size reads as engineering; a limitation discovered by a judge reads as a hole.**

**1 · QUORUM gates paraphrase. It is silent on invention.**
The gate returns a verdict for every claim it could *align to an origin*. A downstream number with **no origin at all** — what fabrication actually looks like — has nothing to align to; it lands in `unaligned[]`, the honesty receipt. That separation is deliberate and correct (*"we refused to guess"* and *"we rejected a proposal"* are genuinely different findings). What was wrong was the pitch implying the gate covers the whole document.
**The fix, and it shipped:** `gate()` reports a **coverage figure** — the fraction of quantified downstream claims it actually had an opinion about — so "covered" is a printed number rather than an implication; and a `strict` mode turns every unaligned quantified claim into an explicit `REJECT · no_origin` for pipelines that want invention gated too. **Copy rule: say "QUORUM gates the matched subset of the document, and prints what fraction that was." Never imply whole-document coverage.**

**2 · QUORUM never re-checks its own ground. Staleness, not drift, is our corpus's dominant failure mode.**
Evidence pointers store a byte-hash of the source file at mint time, and **nothing re-verifies that hash at check time.** The pointer is minted once and trusted forever. This is **Threat 11 — Evidence Drift** in the team's own threat-model review, already documented as future work.
**Its measured size, from this project's own corpus, every figure recomputed from raw data — quote the drift, not the value:** dispatch records written as `252`, then `378`, **and on live recomputation `309 → 311 → 313 → 315`, all inside roughly one day**; a completion rate written as `2/37`, corrected to `2/17`, now `3/22`; a fleet age written as *"six months"* eleven times across the corpus against a real span of **50 days**. **Every one of those was caught by recomputing from the primary file — none by comparing restatements. QUORUM reports nothing on any of them, and every evidence pointer still resolves "valid."** The fix is a re-hash at check time plus a `STALE_EVIDENCE` state; scoped, not built.

⚠️ **This limitation was demonstrated on this very paragraph, four times, and the last one happened while the paragraph was being written.** The dispatch count read `309` in `LOKI-ATTACK.md`, `311` an hour later when this section was first drafted, `313` when `bench/recompute.js` was first run against it — **and the stale `311` sat in this brief, in `BUILD-PLAN.md`, and in `PROJECT-REFERENCE.md`, all three agreeing with each other, all three wrong, until that script caught it.** It was then corrected to `313`, and **`recompute.js` reported `315` in the same session, before the edit was even committed.** No comparison of restatements would ever have found any of this; the documents were perfectly consistent with one another the entire time. Only recomputation from primary data found it.

**Copy rule that follows directly: do not cite the absolute count in prose at all. Cite the sequence and the command.** Editing these figures to a fresher constant is exactly how they went stale in the first place — a constant in a document is a claim with a decay rate, and this one's is roughly **two per recompute**. `bench/recompute.js` exits `1` on drift and `--write` re-stamps, which makes the benchmark fixture **the one instance of staleness in this project that is mechanically detectable.** It lives outside `packages/align` on purpose: it is fixture maintenance, **not** a claim that QUORUM re-verifies its own evidence. It does not, and this brief will not imply that it does.

> **Best available version of this answer, if a judge asks what your weakest point is:** *"Staleness, and I can show you. Our dispatch count went 309, 311, 313, 315 while we were writing the slide that quotes it — and all three of our documents agreed with each other while all three were wrong. That is the failure mode our own tool does not catch, because comparing restatements to each other can never catch it. Only recomputing from the source can, and that is a different product."*

**3 · A gate deployed against an optimising writer teaches it to stop rewriting.**
Goodhart's law applies to us like everything else: if QUORUM sits in-loop, paraphrase is the only thing that costs and verbatim copy is free. Mitigations: QUORUM is scoped as a **release gate, not a training signal** (it sits between an agent and canonical state, never inside a reward loop), and a degenerate verbatim pass is *visible in the report*, not silently rewarded. **The unfixed edge, stated plainly:** caveats are matched by *kind* from a frozen term table in a ±1-sentence window, so **emitting the token satisfies the check** — a writer that learns to append "(preliminary)" while stripping the caveat's substance passes clean. That is the price of having no model in the checking path, and it is a trade we made on purpose.

## 0.4 The measured numbers — including the one that hurts

`LOKI-ATTACK.md` finding 4: *"a gate with no measured false-positive rate is not a gate."* There is now a benchmark (`bench/`, 12 labelled instances, `bench/README.md`), and it reports **two** conditions. **Copy must carry both. Quoting only the first is the exact corruption this product detects.**

| condition | precision | recall | **false-positive rate** | F1 |
|---|---|---|---|---|
| **claim-level** (checker pointed at the clause) | **100.0%** | **33.3%** | **0.0%** | **50.0%** |
| **document-level** (`--raw`, whole cited line) | **0.0%** | **0.0%** | **100.0%** | n/a |

**State the denominators or do not state the numbers.** Five scored instances: 3 corrupt, 2 clean. `precision 100%` is 1 true positive and 0 false positives. **`FPR 0%` is measured over exactly ONE instance** — the second clean row (`B04`) produces no alignment at all, so it falls out of the false-positive calculation entirely rather than landing in it. A 0% false-positive rate over a denominator of 1 is true and nearly worthless, and **reporting it without its base would be `denominator_loss` — the corruption class our own headline example is labelled with, committed by our own benchmark.** So we say it first.

**The gap between the rows is a real finding, not an embarrassment to bury.** It is three named, individually fixable extractor bugs, each diagnosed by running `extract.js` directly (full detail in `bench/README.md`):

1. **Primary-selection disagreement.** On a line carrying four quantities, `pickPrimary()` returns `0.79%` for the origin and `~100%` for the restatement — the two sides select *different facts to be about*, produce no alignment, and the corruption goes silently unreported. This is all three document-level misses.
2. **Unit mis-attachment across a delimiter.** In the table row `friday 2/37 (5%) - edith 5/18 (28%) - ...`, the extractor binds friday's `5%` to the noun `edith`, on the far side of the separator. The differ then correctly fires `unit_drift` on a pair that was clean. **The differ is not wrong; the extractor handed it a mislabelled pair.**
3. **Cross-dimension restatement — and this one fails in BOTH modes.** Origin `friday 2/37 (5%)` parses as `percent`; the restatement `finished 2 jobs out of 37` parses as `count`. A percent cannot align to a count, so nothing is checked — even though `2/37`, `5%`, and `2 out of 37` are the same fact in three surface forms.

**Say this, in these words:** *"QUORUM survives **lexical** paraphrase. It does not yet survive **dimensional** paraphrase — a rate restated as its underlying ratio. We know that because we measured it, and the flag that measures it ships in the repo."*

⚠️ **Second-order point worth making to a technical judge, because it is the kind of thing that wins rooms:** an alignment failure on a clean pair does not *look* like a false positive — it silently removes that instance from the FPR denominator. **A gate that fails to align often enough will report a flattering false-positive rate for exactly the wrong reason.** That is why `bench/run.js` prints the `NO_VERDICT` count next to every metric instead of folding it in.

**Never write** "QUORUM achieves 100% precision" unqualified. **Do write** "at claim granularity QUORUM is precise and does not misfire; at document granularity it currently fails, and here are the three extractor bugs that cause it — run `node bench/run.js --raw` yourself."

---

## 1. The one-line pitch (multiple registers, pick what fits)

**Punchy / social:**
> QUORUM — an agent wrote a number with its base, then restated it fifteen lines later without one. We built the checker that catches that, with the network off.

**Technical (Discord/HN-flavored):**
> QUORUM — a CLI + zero-dependency library that checks agent-to-agent handoffs: realigns paraphrased claim restatements to their origin (IDF-weighted lexical scoring, no embeddings, no LLM), diffs for value/unit/denominator/caveat drift, and binds each claim to an ed25519-signed, stakeable attestation. `npx baton check ./briefs` — fully offline.

**Dry / minimal:**
> QUORUM — provenance for claims, not files. Catches what in-toto can't: a number that drifted between agents while the paraphrase around it looked fine.

---

## 2. The problem, in plain language

A research brief moves through a pipeline: an agent gathers facts, another condenses them, another polishes the deliverable, and somebody acts on what comes out the end.

**The number that arrives is not always the number that was found — and it looks *better*, not worse, after each rewrite, which is why nobody catches it.** A rewritten sentence reads as cleaner writing, not as corruption in progress.

**And it does not require a handoff.** Our own strongest instance happened inside a single agent's single document, fifteen lines apart — which means the failure mode is not "agents are careless when passing things to each other." It is that **restating a quantity is a lossy operation regardless of who performs it.** That is why the fix has to be mechanical rather than procedural.

Nobody notices because nobody is checking the *claim* — only whether the message technically arrived and validated against a schema.

## 3. Why this is a real, felt pain point (not invented for the pitch)

**It happened to this exact team, in this exact project, before QUORUM was conceived.**

> ⚠️ **Copywriter's note — this section was wrong twice and was corrected from primary data both times.** An earlier version of this brief described the evidence below as "three agents passing a number down a chain." It is not. Do not restore that phrasing, do not write "three hops," and do not describe `raven-deep-trust.md` as the origin. The accurate version is below and it is a better story. This correction is itself the project's thesis applied to the project's own copy.

### The instance QUORUM catches — one agent, one document, fifteen lines

| Position | Document | What it said | State |
|---|---|---|---|
| Base stated | `zeus-confidence-routing.md:158` | "**2 of 252 dispatch records** carry a confidence value (0.79%)" | Rate **and** its denominator present. |
| Restated 15 lines later | `zeus-confidence-routing.md:173` | "**Kevin's fleet reports 0.79%**" | **Base is gone.** |

The now-baseless percentage is then compared against a published range of "50–91%" and declared "two orders of magnitude below" — a comparison only valid if the two percentages share a comparable base. They don't. **Same agent, same file, same sitting, no handoff involved.**

**Why `raven-deep-trust.md` is in the corpus but is NOT the origin.** `raven-deep-trust.md:81` states the same figure, and it is a **concurrent sibling, not an upstream hop.** Recomputed from `D:\Projects\Stark-Core\state\dispatches.jsonl` (deduplicated on `key`; **the dispatch count moves every few minutes — see §0.3 — but the two `started_at` timestamps below are historical records and do not**), the `started_at` field reads `zeus 2026-08-27T13:52:26` and `raven 2026-08-27T13:53:28` — **62.0 seconds apart, running concurrently, neither reading the other's file.** Both received the figure from the same dispatch brief and both say so in their own text. Copy must not imply a chain, a hop order, or a direction of travel between those two documents.

### The instance QUORUM deliberately does NOT catch — and this is a feature to lead with

A figure written as `2/37 = 5%` propagated to four separate locations; the true figure was `2/17 = 12%`. **This was NOT corrupted in transit.** It was wrong the first time anyone wrote it down, and then it was copied perfectly — the transit was clean, the origin was wrong, and the only thing that ever fixed it was recounting the raw data two hours later.

**This is "origin poisoning," and it is the exact class §0's trust boundary says QUORUM cannot catch.** The team's independent threat-model review uses *these same two numbers* as its textbook example of it. Run QUORUM over that chain and it returns **ACCEPT** while the number is still wrong by a factor of two.

**Use it that way, on purpose.** Suggested copy:

> "Here is a number from our own corpus that QUORUM passes clean, and it is wrong by a factor of two. It was wrong before anything was handed to anyone, so there was nothing for us to compare it against. That is origin truth, not handoff integrity, and we don't claim it. If you want to know what to trust in a system, ask what it fails on — this is ours, and we brought the example with us."

**Never present `2/37 → 2/17` as something QUORUM detects.** It is the counterexample, and it is worth more as one.

**This is real, found evidence — not staged for a demo.** It predates the project. Anyone can open the files and check it by hand.

### The eight instances are now a benchmark, not an anecdote

The labelled corruption instances from the corpus are extracted into a structured fixture at `fixtures/benchmark/instances.json` — **12 distinct, individually checkable pairs, `B01`–`B12`** — each with source location, claimed value, true value, corruption class, and how ground truth was established, **including the confirmed clean cases**, which is what makes a false-positive rate computable at all. `bench/run.js` runs QUORUM's real `gate()` and real `diffClaim` against them — no mocks, no injected differ — and prints precision, recall, and false-positive rate.

⚠️ **On the number "eight."** The pitch and `LOKI-ATTACK.md` say *"eight more instances"*; the fixture enumerates **12**. Both are honest: the eight comes from `loki-deep-trust.md:295-302`, which lists three named figures plus *"every per-agent figure in raven's line 19 — five instances"*, and friday's `2/37` appears in both halves. **If a judge counts, cite the enumeration (`B01`–`B12`), not the headline number.** The fixture's own `instance_count_note` says exactly this.

**Only 5 of the 12 are scored.** Each instance carries a `scope`, and the headline metric is computed over `handoff_integrity` only — the rows where QUORUM claims to have an opinion. `origin_truth` rows (5) are scored separately as *"correctly silent"*, because counting them as misses would be attacking a claim the project never made. `invention` (1) is reported as a coverage gap. `hard_case` (1) is excluded from the headline **and printed anyway with its reasoning**, because a benchmark that quietly decided its own ambiguous cases in its own favour would not be evidence of anything.

**The measured results are in §0.4 and they are not uniformly flattering. Use both rows.**

**Opening line for any pitch:**
> "We invented this corruption class from one near-miss in our own research process — then found more of it inside the very documents that were analyzing the first one. We labelled them, recomputed the ground truth from the raw data, and turned it into a benchmark — so you don't have to take our word for any of it. It reports a false-positive rate of zero at claim level and a hundred percent at document level, and we'll tell you exactly why before you ask."

## 4. What QUORUM does

1. **Mints** every factual/numeric claim in a source document with an evidence pointer (file + exact byte range) back to where it was found.
2. **Realigns** each downstream restatement to its origin claim — even when the downstream agent rewrote it entirely in its own words and carried no ID forward. This is the hard part: alignment works via lexical + numeric similarity scoring, not by matching a copied identifier.
3. **Diffs** the aligned pair for four corruption classes:
   - **Value drift** — the number itself changed (44 → 60)
   - **Unit drift** — the unit or subject changed ("% of dispatches" → "% of agents")
   - **Denominator loss** — the rate survives but the base it was computed over is dropped or silently changed (the project's signature finding — see §3)
   - **Caveat stripping** — a qualifier like "unverified" or "estimated" present at the source is silently dropped downstream
4. **Signs** every claim with ed25519 so provenance is cryptographically checkable, not just logged.
5. **Stakes** value as an **optional accountability layer** — subordinate to the claim-integrity mechanism, never wired to slash automatically from a `gate()` verdict.

   > ⚠️ **Copy rule, non-negotiable:** never write that a party who **"proves a claim false"** can slash the stake. **QUORUM never proves anything false.** It proves two statements *differ*, and it has no mechanism to decide which side is correct — that is precisely what §0's trust boundary admits. A slash rule that fires on "differed" moves money against the agent who faithfully restated a poisoned number, or against the one who corrected it; and because a downstream agent authors both the restatement and the trigger, one party can control both halves. The correct claim: **the stake makes an identifiable party accountable for an attestation and records the dispute with its class and claim id. Adjudicating who was right is a human or a separate oracle.** (The mentor's threat-model review reaches the same conclusion at its line 760: for the hackathon, staking stays optional and subordinate.)
6. Runs the entire check **deterministically, with no network connection and no LLM call.** The agents producing the content are models; the thing checking them is not, on purpose — that asymmetry is the whole trust argument.

## 5. Why it's genuinely hard (not "a diff with extra steps")

The naive version of this — require every downstream agent to carry a claim ID forward, then string-compare — is trivial and was explicitly rejected during design. **If the ID is mandatory and copied, detecting drift becomes an `if` statement, and the honest answer to "isn't this just comparing two numbers?" is yes** — which kills a pitch on the spot.

The real version requires **no ID be carried at all.** QUORUM has to figure out on its own that a sentence written in completely different words is talking about the same fact as one three documents upstream — and then notice that a number inside it moved. That's a genuine alignment problem (closer to citation-matching / entity-resolution than to a hash comparison), solved here with zero third-party dependencies and zero network calls: IDF-weighted lexical similarity, hedge-word normalization ("nearly half" ≈ 44%), and a scoring lane specifically for claims where the number itself is the thing that drifted.

**Say this before a judge or reader can:**
> "The nearest prior art — in-toto, SLSA, Sigstore — signs the *file*. It will happily attest a report whose 44 became 60, because the file it signed really is the file that was produced. We check the *claim inside* the file."

## 6. Why crypto/staking, specifically — not decoration

A signature only proves *who* said something, not whether it was true. To make a claim's author actually accountable — especially when the agents involved belong to different operators who don't inherently trust each other — three things are needed simultaneously: an identity nobody controls, a value that can be locked by someone other than its owner, and a rule that burns it without either party's consent. **There is no non-cryptographic way to get all three at once between mutually distrusting parties.** That's the honest justification, and it's also the honest answer to "why does this need a chain?" — most of QUORUM doesn't; only third-party accountability does.

## 7. Comparisons — precise, not hand-wavy

| System | What it actually verifies | The gap QUORUM fills |
|---|---|---|
| **in-toto / SLSA / Sigstore** (industry standard supply-chain provenance) | That a specific process produced a specific file, signed by a known identity | Verifies the artifact, not the claims inside it. A corrupted number inside a correctly-signed file passes clean. |
| **GitHub Artifact Attestations** | Same category as above, opt-in, CI-side | Same gap — signs the build, not the content's internal consistency. |
| ⭐ **Summarization-faithfulness metrics** — **AlignScore** (Zha, Yang, Li & Hu, **ACL 2023 long paper**, [aclanthology.org/2023.acl-long.634](https://aclanthology.org/2023.acl-long.634/) · [arXiv:2305.16739](https://arxiv.org/abs/2305.16739)) ✅ *citation verified against source*, **SummaC**, **QAGS**, **QuestEval**, **FactCC**, **QAFactEval** | Whether a summary's information is entailed by / answerable from its source. AlignScore is literally a *unified alignment function* over two text pieces; SummaC aggregates sentence-pair NLI; QAGS/QuestEval generate questions and compare answers across source and summary. | **This is the true nearest neighbour — name it first, before a judge does.** They are **evaluation instruments**: a real-valued score, computed offline, in a research setting, **with a neural model in the loop** (AlignScore is a 355M-param trained model). QUORUM is a **gate**: a per-claim ACCEPT/REJECT in the pipeline, deterministic, reproducible byte-for-byte, **with no model in the checking path**. Three things absent from that whole literature: a **typed corruption taxonomy** (`denominator_loss` is not a category anywhere in it), an explicit **refuse-to-guess state** instead of a forced score, and offline reproducibility. |
| ⭐ **Numerical claim verification** — **QuanTemp** ([arXiv:2403.17169](https://arxiv.org/pdf/2403.17169)), **CLEF CheckThat! 2025 Task 3** | Fact-checking claims that contain quantities, against retrieved open-domain evidence. | Closest neighbour *on subject matter* — quantities are its native object, and its own literature reports that LLMs underperform smaller numerically-pretrained NLI models on this task, which supports our no-LLM-in-the-checker stance. But it verifies a claim **against the world**; QUORUM verifies a restatement **against its own origin**. Different question: they do origin truth, we do handoff integrity. **They are the reason we can say our trust boundary is a real distinction and not an excuse.** |
| ⭐ **Probabilistic record linkage** — **Fellegi–Sunter (1969)**, *A Theory for Record Linkage*, **JASA 64, pp. 1183–1210** ✅ *citation verified against source* | Whether two records refer to the same entity, via a likelihood ratio, with a **three-way decision: link / possible-link / non-link** — comparison score `R > Tµ` links, `R < Tλ` does not, and the band **between** the two thresholds is held for **clerical review**. Their "fundamental theorem for record linkage" shows the optimal rule *is* a likelihood-ratio test. | **Say the name first — our margin gate is this shape and it is 57 years old.** The honest difference: `Tµ` and `Tλ` are **absolute** cuts, derived from two chosen error rates (µ = link a non-match, λ = fail to link a match) and calibrated against a labelled population — the theory does not supply them. Our 0.07 is a **relative** margin: a match must beat *its own runner-up*, so it is meaningful with no calibration data and no labelled population, which a hackathon build does not have. **And the deferred middle band is the same idea as our refuse-to-guess state — 1969 already knew that "I am not sure" must be a first-class output rather than a forced answer.** Being the same shape as a classic result is a compliment; being caught not knowing it is the problem. |
| **Citation/groundedness checkers** (common in RAG tooling) | Whether a sentence is "supported" by a source at all | Binary supported/unsupported — doesn't catch a number that is supported but has drifted from its original value or lost its denominator. |
| **Agent reputation systems** (a saturated 2026 category) | A trailing score based on self-reported or aggregate outcomes | Says nothing about any *individual* claim right now; reputation is a lagging, gameable signal — QUORUM checks the specific handoff in front of you. |

**Why the checker must not itself be a model — the strong version of the argument.** The reason is not that offline is convenient. It is that **a model-based checker shares the summariser's blind spot.** Faithfulness failure tracks a mid-to-late-layer circuit (r = 0.815 / 0.734, arXiv 2604.01457v3, COLM 2026 — read directly from source by this project's own research pass, cited at `zeus-confidence-routing.md:79`) that no prompt fixes. **A checker that can hallucinate cannot be a gate.** Use this sentence whenever someone asks "why not just ask an LLM?"

**Never claim:** that QUORUM invented cryptographic signing (established prior art ships this today); that it invented the idea of provenance for AI systems in general; or that no prior work aligns a candidate text to a source — **AlignScore does exactly that and its name says so.** The defensible claim is narrower and survives scrutiny: *no shipped system does claim-level, paraphrase-surviving, denominator-aware **gating** — a deterministic per-claim ACCEPT/REJECT with no model in the checking path and an explicit refuse-to-guess state.*

## 8. Who this is for / real-world use cases

**Ordered by where QUORUM is hardest to replace — lead with the first one, not the third.** The honest test for every buyer is: *could they just recompute the number from the primary data instead?* Where recomputation is available it is cheaper than QUORUM **and catches strictly more**, because it catches origin errors too. QUORUM wins where recomputing is impossible.

1. ⭐ **Teams whose agents belong to different operators or organisations** — where Org B structurally *cannot* recompute Org A's source, because it does not have it. **This is the only buyer for whom "why not just recompute?" has no answer**, and it is the strongest use case, not a footnote. The team's own threat-model review independently arrived at exactly this framing (its "Recommended Hackathon Demo": two machines, two organisations, a signed claim package over a network handoff). Cross-org registry exchange is **named as not built tonight** — say so — but this is the buyer the architecture is for.
2. **Pipelines where the source is gone, expensive, or one-time** — a measurement taken once, an API whose result is not reproducible, a scrape of a page that has since changed, a compute run nobody will pay for twice. Recomputation is not an option, so restatement integrity is the only integrity available.
3. **Any team running a multi-agent research or reporting pipeline** where a number produced early gets summarized, rewritten, and eventually acted on downstream (the shape of "AI deep research" tools, internal agent pipelines, RAG-plus-summarizer stacks). ⚠️ **Be honest in copy about this one:** if their primary data sits next to their prose, recomputation beats us. QUORUM's value here is *catching the drift automatically and continuously* rather than requiring someone to think to recompute — which is real, but it is a convenience argument, not an impossibility argument. Don't oversell it.

**Also true and worth saying:** anyone shipping a multi-agent product needs a credible answer to *"what happens when one agent hands bad or corrupted context to the next?"* — the literal test this class of project is judged against.

## 9. The demo, described (for anyone writing copy about "how it works")

A judge or viewer is handed a real, human-readable text document mid-pipeline and edits it themselves — deletes a qualifier, changes a number, whatever they choose. They are not editing a config file or JSON; it looks and behaves like editing a document. Running the check afterward doesn't just say "something's wrong" — it names the exact hop where the corruption entered and the exact class it belongs to (e.g., "the summarizer's rewrite dropped the denominator; the surviving percentage is arithmetically consistent with a base that was never stated, which is exactly why it doesn't look wrong on its face"). A tampered claim's signature visibly fails verification. If staking is engaged, the responsible party's stake is visibly slashed.

## 10. Failure modes to avoid in any generated copy

- **Do not invent statistics.** Every number in this brief is sourced to a specific file and line in the project's own research corpus (§3). If a generated draft needs a number not listed here, flag it rather than inventing one — this project's entire premise is that unverified numbers are the problem.
- ⛔ **Do not write "three agents," "three hops," or "down a chain."** The demo evidence is **one agent restating himself fifteen lines apart in one document**, with a second agent's document present as a *concurrent sibling* (62.0 seconds apart, neither reading the other). This exact phrase was in an earlier version of this brief and was false. It is the single most likely error for a copy generator to reintroduce, because it is the more familiar story. **The accurate version is the better story — use it.**
- ⛔ **Do not present `2/37 → 2/17` as something QUORUM catches.** It is origin poisoning, the class the trust boundary explicitly excludes, and QUORUM returns ACCEPT on it. Present it as the volunteered counterexample (§3) or not at all.
- ⛔ **Do not write that anyone "proves a claim false" or that the stake fires on falsity.** QUORUM proves two statements *differ*. See §4.5.
- ⛔ **Do not imply the gate covers a whole document.** It covers the subset it could align to an origin, and it prints that fraction. See §0.3.
- ⛔ **Do not claim no prior work aligns text to a source.** AlignScore (ACL 2023) does precisely that. The defensible novelty is *gating*, the typed taxonomy, refuse-to-guess, and no model in the checking path. See §7.
- **Do not claim legal or regulatory authority.** QUORUM reports what happened to a claim; it does not rule on anyone's honesty or intent.
- **Do not overclaim novelty on signing.** Cryptographic attestation of artifacts is established (in-toto/SLSA/Sigstore, GitHub Attestations). The novel part is claim-level, paraphrase-surviving checking — say that specifically, not "we invented provenance."
- **Do not describe the UI as a "dashboard."** It renders one interaction (a tampered claim, a broken signature, a slash), not an analytics surface — copy should reflect that it's a demonstration, not a monitoring tool.

---

## Suggested prompt to pair with this file

> "Using only the facts, quotes, and comparisons in the attached brief, write [landing page copy / a pitch deck outline / a README intro] for a project called QUORUM. Keep every specific number and quote traceable to the brief — do not add statistics or comparisons that aren't in it. Tone: technical, confident, not hypey. Audience: [hackathon judges with security/crypto backgrounds / a technical Discord / general developers — pick one]."
