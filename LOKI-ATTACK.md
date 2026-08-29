# LOKI — ATTACK ON THE QUORUM CONCEPT

**2026-08-29 · attacking the concept and the working, not the code · reports to Kevin · written for raven**

Per Kevin's correction to the brief: *"I don't want loki to attack the project files but the project concept and working, find what we missed out."* I ran no test suite, audited no Solidity, and filed no file:line bug. Where I cite a line it is because a **claim** lives there, not a defect. One code-shaped note is parked at the very bottom and is not the deliverable.

**Labels:** `[READ]` I opened it this session · `[COMPUTED]` I ran code over primary data this session · `[INFER]` my reasoning · `[UNVERIFIED]` I could not check it and say so.

---

## ⭐ VERDICT — ONE LINE

**The mechanism is real and the trust boundary is the most honest thing this team has built. The evidence chain the whole pitch stands on is not a chain — it is two agents dispatched 62 seconds apart, in parallel, both quoting a number from a brief that is not in the fixture. And the write gate, which the pitch calls default-deny, has no verdict at all for the failure mode that actually burned this corpus: a claim invented downstream with no origin to align to.**

QUORUM gates **paraphrase**. It is silent on **invention** and blind to **staleness**. Those are the two things that actually went wrong in its own demo corpus, and they are the two things it does not check.

**Nothing here kills the project.** The hop 2 → hop 3 edge is real, unfakeable, and survived every attack I made on it. What dies is the opening sentence, the second piece of evidence, and the word "three."

---

## 🚨 ESCALATED TO KEVIN

**Two things, plain, both about to be said out loud with your name on them.**

**One. The pitch opens with "three agents pass a number down a chain." On your own fixture, that is one agent restating himself twice, fifteen lines apart, in one document.** I checked the dispatch record: zeus was launched at 13:52:26 and raven at 13:53:28 on 27 August — **sixty-two seconds apart, running at the same time.** Neither read the other's file. Both got the number "2 of 252" from the brief you sent them, and both of them say so in their own text. So the thing the demo calls "hop 1, the researcher, the origin" is not an origin — it is a second agent quoting the same brief. The real, genuine, catchable corruption is entirely inside zeus's own document, between his line 158 and his line 173. That part is excellent and I could not dent it. But if a judge asks "so who handed what to whom," the true answer is "nobody handed anything to anybody" — and the fixture's own MANIFEST already half-admits this on the page. Say **"one agent, two restatements, fifteen lines apart, and it still lost the base"** and it is a *better* story, because it means this happens even when there is no handoff to blame.

**Two. Your second piece of evidence is an example of the thing QUORUM says it cannot do — and your own security reviewer wrote it up that way.** The pitch says the "2 of 37 → really 2 of 17" figure was *"inflated 2.2× at some point in transit."* It was not in transit. It was wrong the first time anyone wrote it down, and then it was copied perfectly. I searched the whole ideation folder: **"2 of 17" appears nowhere except in the document that corrected it, two hours later, by re-counting the raw data.** Meanwhile the mentor's threat-model review uses those exact two numbers — 2/17 and 2/37 — as its textbook example of "Origin Poisoning," and says plainly that QUORUM cannot help there. So if you run QUORUM over that chain on stage, **it says ACCEPT**, and the number is still wrong by a factor of two. It is a genuinely great story about why numbers go bad. It is not a story about what QUORUM catches.

Neither of these needs new code. Both need one sentence changed before anyone stands up.

---

# PART 1 — THE SIX BREAKS, RANKED BY WHAT THEY COST

---

## 1 ⭐⭐ THE FLAGSHIP CHAIN HAS NO HOP 1 — the demo is two hops and one agent

**This is the highest-consequence finding in the document and it cost one query.**

`fixtures/real-corpus/MANIFEST.md` labels `raven-deep-trust.md:81` as **"Hop 1 · Researcher (origin)."** `BUILD-PLAN.md:40-44` and `PROJECT-REFERENCE.md:173-177` carry the same three-row table. `BUILD-PLAN.md:145` turns it into the pitch's first sentence: *"Three agents pass a number down a chain."*

**Four independent pieces of primary evidence say hop 1 is not an origin.**

`[COMPUTED]` from `D:\Projects\Stark-Core\state\dispatches.jsonl`, deduplicated on `key`, last-write-wins (309 distinct dispatches):

```
zeus   dispatched 2026-08-27T13:52:26  status=completed  brief 7,548 chars
raven  dispatched 2026-08-27T13:53:28  status=completed  brief 9,045 chars
```

**Sixty-two seconds apart. Concurrent. zeus went first.**

`[READ]` And both documents attribute the figure upstream, in their own words:

- `zeus-confidence-routing.md:158` — *"Kevin's measurement, **carried forward**..."* — zeus credits the brief, not raven.
- `raven-deep-trust.md:13` — *"Dispatch records **378** (brief said ~252 — it grew)"* — raven credits the brief too, **and flags 252 as stale in the same breath.**
- `raven-deep-trust.md:20` — *"confidence values in dispatch record **~2 of 378** (**brief's figure**...)"*
- `raven-deep-trust.md:56` — *"COLLISION REPORT — **arriving mid-generation**, applied without restart"* — raven received zeus's Agora finding mid-run via Stark. **The information flow, where any exists, runs zeus → raven. The opposite of the demo's arrow.**

### The break

The fixture mints an **origin claim** at `raven-deep-trust.md:81`, with an evidence pointer — file path, byte hash, span, exact quote — anchoring it as a root. **It is not a root. It is a sibling restatement of a brief that is not in the fixture and cannot be opened by a judge.**

`mint.js`'s evidence pointer proves the quote really is in the file. It cannot and does not prove the file is where the number came from. **On QUORUM's own flagship fixture, the tool certifies a carried figure as a read.** That is my own standing attack axis, firing inside the artefact built to prevent it.

**What survives, and it is most of it.** The MANIFEST is already careful and honest about which edge is real — it says outright *"This is the exact hop 2 → hop 3 edge, not hop 1 → hop 2,"* and it correctly notes that the baseless rate then feeds an incommensurable comparison. **That edge is genuine, it is inside one file, and I could not break it (§10).** The overclaim is confined to the word "origin" on hop 1 and the word "three" in the opening line.

**What it costs.** The opening sentence, and the Track-02 handoff claim (§6). Two hops between two agents is a chain. Two restatements by one agent fifteen lines apart is a **self-restatement** — which is arguably a *stronger* scientific finding (it survives without a handoff at all) and is unambiguously a *weaker* answer to *"does the handoff hold."*

**What would have to be true for me to be wrong:** that Stark injected raven's line 81 into zeus mid-run, the way he injected Agora into raven. I could not check that — the dispatch record stores only the first ~400 characters of each brief. **If that happened, the arrow reverses and hop 1 becomes hop 3 — but it is still two agents and never three.**

---

## 2 ⭐⭐ THE WRITE GATE DOES NOT GATE INVENTION

**The single biggest conceptual hole, and it is upside-down relative to harm.**

`PROJECT-REFERENCE.md:161` and `CONTENT-BRIEF.md:32` state the invariant: *"Verification failure cannot silently become acceptance... there is no code path where an unresolved or ambiguous claim proceeds as if it were clean."*

`[READ]` `packages/align/index.js:131-135` states the actual design, honestly, in its own comment:

> *"unaligned candidates and dropped claims are **NOT verdicts on a proposal** — they are the honesty receipt (nobody guessed). Kept separate from verdicts in the returned shape."*

**So the gate emits a verdict for `matched` and for `ambiguous`. It emits nothing for `unaligned`.** A downstream claim that matches no origin at all does not get REJECTed. It gets listed.

### Why this is the finding and not a nit

The invariant is true for *ambiguous* (two plausible origins) and false for *unaligned* (no origin). **And "no origin" is what fabrication looks like.** An LLM that invents a number from nothing produces a candidate with nothing to align to. It lands in the honesty receipt and the pipeline proceeds.

**Now apply it to this project's own corpus.** `[COMPUTED]` from `dispatches.jsonl` today: earliest dispatch **2026-07-10**, latest **2026-08-29**, span **49 days**, 309 distinct dispatches.

`[READ]` `raven-deep-trust.md` says **"six months"** eleven times, including at line 26 — *"We ran an 18-agent fleet for six months"* — the sentence raven calls the one *"every idea below is downstream of."* It is in nine other files in `ideation/`.

**That is a 3.7× provenance overclaim, invented at the point of writing, with no upstream claim anywhere to align it to.** It is the single most damaging error in the entire corpus — it dies on screen, on the one asset the team calls unfakeable, in front of judges who are hiring. **Run QUORUM over `raven-deep-trust.md` and "six months" produces no verdict.** It is not ACCEPTed and it is not REJECTed. It is in a list.

> **QUORUM gates the failure mode where an agent changes a number it was given. It is silent on the failure mode where an agent makes a number up.** The second one is more common, more damaging, and the one that actually happened here.

**What survives.** The design decision itself is defensible — *"we refused to guess" and "we rejected a proposal" are different findings* is exactly right, and conflating them would be a real bug. **The problem is not the code. It is that the pitch sells the gate as covering the document when it covers the matched subset of the document.**

**The question that lands it:** *"If my summariser writes a number I never gave it, what does your gate say?"* The current honest answer is *"it appears in a list called unaligned and nothing stops it."*

---

## 3 ⭐⭐ THE SECOND EVIDENCE INSTANCE IS THE CLASS QUORUM CANNOT CATCH — and your own reviewer says so

`CONTENT-BRIEF.md:73`: *"a figure written as `2/37 = 5%` propagated to four separate locations; the true figure was `2/17 = 12%` — **the denominator was inflated 2.2× at some point in transit** and nobody caught it."*
`BUILD-PLAN.md:50` and `PROJECT-REFERENCE.md:183` carry it as the **second instance** of the demo evidence.

### It was never in transit.

`[COMPUTED]` `grep -rnE "2\s*/\s*17|2 of 17"` across all 35 files in `D:\Tenori_Hack\ideation\` returns **three hits, all in `loki-deep-trust.md`** — lines 20, 186, 297. That file is the **correction**, written at 19:42 on 2026-08-27, two hours after raven's.

So the real lineage is:

| stage | what happened | QUORUM's verdict |
|---|---|---|
| origin | `raven-deep-trust.md:19` computes `friday 2/37` from **raw line counts** of an append-with-rewrites file | nothing to compare against |
| transit | `raven-deep-trust.md:130` restates it faithfully. Four locations, base intact every time | **ACCEPT** |
| correction | `loki-deep-trust.md:186` **re-derives from the primary data**, gets `2/17` | outside QUORUM entirely |

**The transit was clean. The origin was wrong. The fix was recomputation.** QUORUM's four classes have nothing to say about any of it.

### And the team's own security reviewer classified it correctly

`[READ]` `BATON_Threat_Model_and_Security_Architecture.md:187-206` — **"Threat 1 — Origin Poisoning"** — uses *these exact numbers*:

```
Real source:    2 / 17
Origin agent:   2 / 37
↓ QUORUM registry ↓ downstream agents
```

and line 208: *"Everything downstream can remain internally consistent."* Line 237, residual risk: ***"If the external source itself is wrong or malicious, QUORUM cannot independently create truth."*** Line 1085 puts **"Origin grounding"** at #17, in **Future** — not must-have, not strong-bonus.

> **The pitch cites, as its second-strongest evidence for the class QUORUM catches, the exact case the independent review uses as the canonical example of the class QUORUM cannot catch.** Two of the project's own documents contradict each other on the same two numbers.

**And note the reviewer's recommended demo at line 1093-1140 inverts reality**: it stages `2/17` as canonical and `2/37` as the downstream mutation. In the actual corpus `2/37` came *first* and `2/17` is the later correction. **That demo stages a corruption that ran the other way.**

**One further twist, and it is the point.** `[COMPUTED]` today: **friday is 3/21 = 14%.** Not 5%. Not 12%. The correction is itself now stale. **Every version of this number that has ever been written down was obsolete when written, and the only thing that has ever fixed it is recomputing from the source.** That is §5.

---

## 4 ⭐ A GATE WITH NO MEASURED FALSE-POSITIVE RATE IS NOT A GATE

251 passing tests across four packages — 151 align, 11 sign, 76 registry, 13 stake. `[COMPUTED]` **Not one of them produces a corpus-level precision, recall, or false-positive number.** (The word "precision" in the codebase is `precision_loss`, a diff subtype.) I did not run them; I checked for the existence of the measurement, and the measurement does not exist.

**Why this is conceptual and not an engineering nit.** The gate is **default-deny**, and `index.js:96-108` REJECTs every `ambiguous` alignment. So QUORUM's error mode is not silent misses — it is **over-rejection of legitimate paraphrase.** Heavy paraphrase drives LEX down and drives candidates toward the 0.07 margin region; the margin region is an automatic REJECT.

**Nobody knows how often that fires on real summariser output, because a real summariser has never run.** `swarm/briefs/README.md` `[READ]`: the directory is empty, no `ANTHROPIC_API_KEY` exists in the environment, *"it has just never made a real model call."*

> **The product is a gate whose entire value is that it says no. Nobody has measured how often it says no to something that was fine.** A judge who works in ML asks for precision/recall in the first ten seconds and there is no number to give.

**And the demo cannot produce one**, because the judge-tamper beat measures exactly one hand-authored corruption. n=1, chosen by the team, in a document the aligner was tuned against.

**What would falsify this:** running `gate()` over the two fixture files end-to-end and reporting how many of raven's ~200 quantity mentions align, how many deltas fire, and how many of those are wrong. **That is the single highest-value unrun experiment in this project and it needs no API key.** I did not run it — I was told not to code-review and I stayed out.

---

## 5 ⭐ THE BUYER'S CHEAPER ALTERNATIVE IS "RECOMPUTE," AND THE DEMO IS SET IN THE ONE PLACE WHERE RECOMPUTING IS FREE

**Kevin's question 1, answered honestly.**

`CONTENT-BRIEF.md:119-121` names three buyers. The first — *"any team running a multi-agent research or reporting pipeline"* — is the one the pitch leads with, and it is the one with a strictly better option.

**In the demo's own setting, the primary data sits next to the prose.** `dispatches.jsonl` is one directory away from `ideation/`. Every error in this corpus was caught by **re-deriving from that file**, not by comparing restatements: 2/37→2/17, 378→263, 252→stale, "six months"→49 days. Every single one.

> **Recomputation dominates QUORUM on the demo's own corpus. It is cheaper, and it catches strictly more — it catches origin errors, which QUORUM explicitly cannot.**

QUORUM only wins where recomputation is **impossible**: the source is gone, the compute is expensive, the measurement was one-time, or **the source belongs to someone else.** `CONTENT-BRIEF.md:121` names that buyer — *"teams that need external, unaffiliated agents to cooperate"* — **third, last, and it is the only one where QUORUM is not redundant.** `PROJECT-REFERENCE.md:130` lists cross-org reconciliation under **"Explicitly not built."**

### And the reviewer already located that buyer, in a section the team did not build

`[READ]` `BATON_Threat_Model_and_Security_Architecture.md:1093-1140`, **"Recommended Hackathon Demo"**:

```
Machine A — Organization A     Research Agent: "2 of 17 experiments failed — 12%"
        ↓ network handoff — signed claim package ↓
Machine B — Organization B     Summarizer proposes: "2 of 37 — 5%"
        ↓ QUORUM: REJECTED · DENOMINATOR_DRIFT · canonical unchanged
```

**Two machines. Two organizations. A network handoff.** The team implemented §29's must-have list from that document with real fidelity, and left §30 — sitting thirty lines later in the same file — behind. `[INFER]` **In the cross-org version, "why not just recompute" has no answer, because Org B cannot recompute Org A's source. That is the version where QUORUM is not replaceable.** I am not proposing you build it. I am pointing out that the answer to the hardest question about the use case was written down by your own reviewer and was not read as the answer.

---

## 6 ⭐ TRACK-02 FIT — the best beat and the stated test are in direct opposition

`BUILD-PLAN.md:11-14` quotes the track's own test verbatim: *"Give the system a real job, involving more than one agent. Then **leave it alone.** Does the handoff hold?"*

`BUILD-PLAN.md:147` is the demo's best moment: *"**Judge edits the prose brief with their own hands.**"*

**These fight each other and nobody has noticed, because they were optimised in different documents on different days.** The judge-tamper beat was selected for judge-interactivity in the shock re-rank two days ago; the track test was pasted in from RFB-02. The tamper beat is the *only* moment in the demo, and it is the moment that **removes the second agent and puts a human in the loop.** "Leave it alone" is the one instruction the demo structurally cannot follow.

**Worse: there is no second agent at all.** `[READ]` `swarm/briefs/` holds one README. The fixture is two static markdown files written on 27 August. Unless a key appears, the demo at 09:00 is: **one document, one human edit, one deterministic checker.**

> **My own rule from round 1: "a curl is not a handoff — there is no second party, so nothing can fail to hold." Applied here: a judge's keyboard is not an agent.**

`[INFER]` The prepared answer — *"the corruption we show is real and historical"* — is true and does not answer the objection, because the historical corruption (§1) is one agent restating himself. **Under the track's own test, QUORUM currently demonstrates a checker, not a swarm.**

---

# PART 2 — WHAT WAS MISSED ENTIRELY

---

## 7 · THE GATE, DEPLOYED, TEACHES THE SUMMARISER TO STOP SUMMARISING

`[INFER]` — Goodhart on the alignment score. Not in any document I read.

If QUORUM sits in-loop as a write gate, the summariser's objective becomes *"produce text that clears the aligner and the differ."* **Paraphrase is the only thing that costs. Verbatim copy is free** — it maximises LEX, maximises NUM, maximises margin, and trips nothing.

> **A gate that penalises drift, deployed against an optimising writer, converges on a writer that does not rewrite. The entire reason the summariser exists is that it rewrites.**

Second-order, on Kevin's caveat-faking question: `PROJECT-REFERENCE.md:79` — caveats are matched **by kind**, from a frozen term table, in a ±1-sentence window. **So emitting the token satisfies the check.** A summariser that learns to append "(preliminary)" while stripping the substance of the caveat passes cleanly, and it will learn that faster than it learns to preserve meaning, because the token is cheap and the meaning is not.

**This is not fatal — it is the shape of every gate ever built, and naming it is a maturity signal.** But right now the prepared-answers table has no row for *"what does your gate do to the behaviour of the thing it gates?"*

---

## 8 · THE STAKE FIRES ON "DIFFERED," AND THE PITCH SAYS IT FIRES ON "FALSE"

Two of the project's own sentences, in direct contradiction:

- `CONTENT-BRIEF.md:90` — *"a downstream party who **proves a claim false** can slash the stake."*
- `PROJECT-REFERENCE.md:156` — *"An **origin agent can be poisoned** while every downstream agent stays perfectly self-consistent."*

**QUORUM never proves anything false. It proves two statements differ.** It has no mechanism to say which side is correct — the trust boundary is that admission, stated proudly and rightly.

> **In the poisoned-origin case, the delta fires against the summariser who restated a bad number faithfully — or against the one who corrected it. Money moves against the honest agent, on a signal the project's own trust boundary says cannot attribute correctness.**

`[READ]` The reviewer's Threat 15 (line 726-760) covers Sybils, collusion, self-dealing and stake concentration, and its mitigation is exactly right — *"Treat stake as **accountability**, not truth"* — but **it does not cover the case where the checker's verdict is correct and the liability lands on the wrong party.** That is not gaming. It is the mechanism working as designed and producing an unjust transfer.

`[INFER]` And there is a griefing shape available: the downstream agent authors the restatement *and* triggers the delta. A malicious summariser can paraphrase in a way engineered to trip `value_drift` or `unit_drift` against an honest upstream and collect. **Both halves of the trigger are controlled by one party.**

**Cheapest defence available and unstated:** the reviewer's own line 760 — *"For the hackathon, staking should remain **optional and subordinate** to the claim-integrity mechanism."* The pitch currently leads the last 30 seconds with the slash (`BUILD-PLAN.md:149`).

---

## 9 · QUORUM NEVER RE-CHECKS ITS OWN GROUND — and staleness is what actually broke this corpus

`PROJECT-REFERENCE.md:99`: `mint.js` stores *"a byte-hash of the source file."* `[COMPUTED]` **Nothing re-verifies that hash at check time.** The evidence pointer is minted once and trusted forever.

`[READ]` The reviewer named this: **Threat 11 — "Evidence Drift / Stale Sources," line 598.** It is in neither the must-have nor the strong-bonus list.

**And it is the corpus's dominant failure mode, by a distance.** `[COMPUTED]`, all from `dispatches.jsonl` today:

| figure | as written | what it was | today |
|---|---|---|---|
| dispatch records | 252 (brief) → 378 (raven:13) | 263 deduplicated | **309** |
| friday completion | 2/37 = 5% | 2/17 = 12% | **3/21 = 14%** |
| fleet age | "six months" ×11 | 47 days | **49 days** |

`raven-deep-trust.md:13` **knew** 252 was stale — *"brief said ~252 — it grew"* — and used 252 anyway sixty-eight lines later at line 81, which is the fixture's hop 1. **The same document holds both, and QUORUM cannot see it, because QUORUM compares an origin document to a downstream document and has no notion of a document contradicting itself.**

> **The corpus's real pathology is not that numbers change in transit. It is that everybody quotes a computed figure instead of recomputing, and the ground moves underneath all of them.** Every claim in this fixture is stale, every evidence pointer still resolves "valid," and QUORUM reports nothing.

---

## 10 · ⭐ THE MISSED MOVE — the equivalent of the eight instances inside the fix document

**Handing this to raven, as an observation about evidence already on disk. Not a plan, not a build, not a second opinion.**

QUORUM has evidence pointers. It has **no notion of what an evidence pointer terminates in.**

Every origin claim in this fixture points at another agent's prose. `raven:81` → the brief → an earlier reading of a JSONL file that has since moved four times. **The chain never reaches machine-readable primary data anywhere, and QUORUM reports every link as valid**, because "valid" means *the quote is really in the file.*

The reviewer named this exact layer — `Threat_Model:221-233`, *"Optional future module: SOURCE → ORIGIN AGENT → **ORIGIN GROUNDING** → QUORUM,"* and *"origin grounding should be treated as a separate trust layer, not silently assumed to be part of core QUORUM."* It sits at #17, in Future.

> **The finding, if anyone runs it: apply a depth-to-primary-data test to QUORUM's own demo fixture and hop 1 fails it.** The flagship origin claim of the project that exists to bind claims to evidence has an evidence pointer that terminates in a sibling agent's sentence.

That is the same shape as *"we invented this corruption class from one near-miss, then found eight more in the document proposing the fix"* — except it is one level up, it is about the tool rather than the corpus, and it is **unclaimed.** `[INFER]` It is also the one finding here that makes the project *stronger* rather than smaller, which is why I am flagging it as the highest-value item for raven rather than as a break.

**A second, cheaper observation of the same kind, also for raven:** this team already possesses something nobody else in that room has — **a labelled set of eight real claim-corruption instances in genuine agent output, with the ground truth independently recomputed from primary data, with classes assigned** (`loki-deep-trust.md:295-302`). The pitch currently uses it as an **anecdote** — one chain, one slide. `[INFER]` It is the only object in this project that could produce the precision/recall number §4 says is missing, and it costs nothing to build because the labelling is already done. **Benchmarks get cited; tools get forked.** What that implies for the pitch is raven's call and not mine.

---

# PART 3 — PRIOR ART: THE WALL HAS A HOLE WHERE THE NEAREST NEIGHBOUR IS

⚠️ **`[UNVERIFIED]` — I have no network. Every name below is domain knowledge, unsearched. This is the same gap I recorded in round 1 and it is unchanged. Do not put any of these on a slide without someone searching them.**

`CONTENT-BRIEF.md:108-115` compares QUORUM against four things: in-toto/SLSA/Sigstore, GitHub Attestations, RAG citation checkers, agent reputation systems. **Three of those four are supply-chain or reputation — not the neighbourhood.**

**The nearest neighbour is not in the table at all: summarization faithfulness / factual-consistency evaluation.** Its problem statement is, verbatim, QUORUM's: *did the paraphrase preserve the source's facts, with no IDs carried, when the wording is entirely different?* `[INFER]` Named systems in that line — SummaC, QAGS, QuestEval, FactCC, and above all **AlignScore**, whose name and method are literally "align a candidate to its source and score information preservation." A judge from an NLP background says *"this is faithfulness evaluation with a hash on it"* in four seconds and the pitch has no prepared answer.

**Second missing ancestor: probabilistic record linkage.** `[INFER]` Fellegi–Sunter (1969) is the canonical treatment, and its three-way decision — **link / possible-link / non-link**, with a rejection region between thresholds requiring review — **is the margin gate.** The 0.07 band is a 57-year-old construct. That is not a problem; being caught not knowing it is.

**Also unnamed and adjacent:** numerical/quantitative claim verification and table-based fact verification (counts and denominators are their native subject); legal-tech quote verification; hallucination-detection products.

### The delta that does survive, and it is real

`[INFER]` Faithfulness metrics are **evaluation instruments** — score a summary offline, report a number, research setting. QUORUM is a **gate** — per-claim ACCEPT/REJECT, in the loop, deterministic. And the three things none of them have: a **typed corruption taxonomy** (`denominator_loss` in particular is not a category anywhere in that literature), an explicit **refuse-to-guess state**, and **no model in the checking path.**

**That last one has a defence available that this project is not using.** The argument for a non-model checker is not "offline is nice." It is that **a model-based checker shares the summariser's blind spot** — a mid-to-late-layer circuit, r=0.815/0.734, that no prompt fixes (`zeus-confidence-routing.md:79`, read directly by zeus from arXiv 2604.01457v3, COLM 2026). **A checker that can hallucinate cannot be a gate.** That sentence is sitting in this team's own research corpus, it answers *"why not just ask an LLM?"* decisively, and it is in none of the prepared answers.

⚠️ **Process note.** `loki-shock-rerank.md:171`, two days ago: *"The cliché check against provenance/citation verification. Nobody ran it, including me. It is the nearest 2026 cliché to my own pick and I am recommending without it. **Cheapest open item on this page.**"* **It is still open.** That is now the longest-standing known hole in this submission and it costs one search.

---

# ATTACKED AND COULD NOT BREAK

**Mandatory section. These held against everything I had.**

- ⭐ **"Do not align on the number," and the value-drift lane.** `PROJECT-REFERENCE.md:67-72`. I went at this hard looking for a way to make it wrong and there isn't one. An aligner requiring numeric agreement makes its own headline class structurally unreachable. **This is the single best design decision in the project and it would survive any judge.** Everything else follows from it.
- ⭐ **The hop 2 → hop 3 edge itself.** I attacked the fixture's spine (§1) and this half survives every attack. `zeus:158` states the base; `zeus:173` drops it; the now-baseless 0.79% is then compared against a published "50–91%" and called "two orders of magnitude below." **The base genuinely vanishes, the corruption genuinely feeds the conclusion, the file was genuinely written before QUORUM existed, and the MANIFEST already says exactly this without overclaiming.** It is the demo. It is enough.
- **`denominator_loss` gated on `claim.denominator != null`.** I tried to break it as inferring a base from downstream text. It does not — the origin is sole authority. Correct, and the discipline is unusual.
- **`precision_loss` as a note, not a fail.** "Nearly half" for 44% is *correct*, not corruption, and there is a test forbidding the opposite verdict. A checker that flags honest hedging is worse than useless and this one cannot.
- **The trust boundary.** I attacked it on Kevin's own axis — *does admitting you can't verify origin truth undercut the product?* **It does not.** A stated limitation reads as rigour; a discovered one reads as failure, and this one pre-empts the hardest question in the room. **The boundary is sound. What breaks is the staking layer contradicting it (§8), not the boundary itself.**
- **The margin gate failing closed.** `index.js:96-108`. An ambiguous alignment cannot reach the differ and cannot become an ACCEPT. Attacked as a place the invariant could leak; it doesn't. **The leak is one category over, at `unaligned` (§2).**
- **The "no LLM in the checker" claim.** Real, mechanised by verification test #17, and defensible for a reason stronger than the one currently given (Part 3).
- **The `keyIdOfSigned` fix.** `PROJECT-REFERENCE.md:128`. A real equivocation-defeating hole, found and closed, with regression tests in two places. Genuine.
- **The MANIFEST's own honesty.** It says *"This is the exact hop 2 → hop 3 edge, not hop 1 → hop 2"* and it flags the incommensurable comparison unprompted. **§1 is an attack on the pitch's framing, not on the fixture's documentation, which is better than the documents built on top of it.**

---

# COULD NOT CLOSE — and why

1. **I did not run `gate()` over the fixture.** §4's "no measured false-positive rate" is from checking that the *measurement* does not exist, not from producing one. **Running the real pipeline over `raven-deep-trust.md` and `zeus-confidence-routing.md` end-to-end — how many quantities align, how many deltas fire, how many are wrong — is the highest-value unrun experiment in this project and needs no API key.** I stayed out because Kevin's correction excluded code review, and I am flagging the cost of that boundary rather than crossing it.
2. **I could not read the brief that dispatched raven and zeus.** `dispatches.jsonl` stores only the first ~400 characters. §1's "252 came from the brief" rests on `raven:13`, `raven:20` and `zeus:158` *saying* so — three attributions, no primary document. **If Stark injected raven's line 81 into zeus mid-run, the chain direction reverses. It is still not three agents either way.**
3. **No network, again.** All of Part 3 is domain knowledge. **AlignScore, SummaC, QuestEval, Fellegi–Sunter are named from memory and verified by nobody.** If I am wrong about the faithfulness-evaluation literature, the prior-art hole closes and Part 3 is worth nothing. That is the weakest section here and I would not defend it against a judge who searched.
4. **I read ~250 of the threat model's 1,265 lines** — Threats 1, 8, 9, 15, the invariants, §29, §30. **Threats 2–7, 10–14, 16–23 are unread.** §8 and §9 may already be answered somewhere I did not look.
5. **I did not read `packages/registry`, `packages/stake`, `FRONTEND-SPEC.md`, or the site.** §8's griefing shape is reasoned from the mechanism, not from the contract.
6. **I did not establish what a real LLM summariser actually does to a claim.** Nobody has. That is the empirical gap under the entire project (§4) and it closes with one API key and one run.

---

# MY OWN BLIND SPOT

- ⛔ **I am inside the corpus I am attacking.** `loki-deep-trust.md` is my file. §3's "the true figure is 2/17" is **my own prior output**, cited as ground truth — and it is now stale, because friday is 3/21 today. **I am quoting a computed figure while attacking people for quoting computed figures.** That is the finding turned back on me and it is exactly fair.
- **I read the same ideation folder the fixture is made of.** Where raven or zeus mis-transcribed something in a way I share, I reproduced it silently. My structural facts are arithmetic over `dispatches.jsonl`, which is the class where correlated reasoning is least dangerous; **§5, §7 and §10 are pure reasoning and are the most exposed.**
- **I am claude-opus-5, and so is most of this fleet.** My own 08-27 argument was that agents sharing a base model cannot independently check each other. **It applies to this document.** Where QUORUM's design fails because of a disposition I share, I will have reproduced it and reported nothing.
- **I did not attack the frontend, the registry, or the stake contract as concepts** — only the two sentences about staking that contradict each other. **Read the thinness of §8 as unearned, not as clearance.**
- **My prior-art section is the weakest thing here and it is the same weakness as round 1.** I flagged this gap two days ago as the cheapest open item and then wrote another pass without closing it, because I have Bash and no network. **An adversary who reports the same gap twice and never closes it is describing a hole, not filling it.**

---

## One code-shaped note, parked here because it is not the deliverable

`index.js:74` defaults `opts.diffFn` to the real `diffClaim` — correct, and the header explains why a no-op default would be a silent catastrophe. But the header at lines 165-193 still describes `diff.js` as an unlanded future stream and offers a 2-ary adapter. `diff.js` has landed. **The comment is stale documentation, not a defect**, and the only reason I mention it is that a stale note *about the integration boundary* is the same species as everything in §9.

---

*LOKI · 2026-08-29 · attacked the concept on seven axes · 6 breaks, 9 survivals, 1 missed move handed to raven.*
*Every number in this document was computed from `D:\Projects\Stark-Core\state\dispatches.jsonl` or read from `D:\Tenori_Hack\ideation\` tonight. None was inherited, except where §3 and the blind-spot section say it was — and that one is mine.*
