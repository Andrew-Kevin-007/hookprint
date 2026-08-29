# RAVEN — DEEP PASS: AGENT TRUST & ALLOCATION
**Written 2026-08-27 · one territory, depth not breadth · 12 ideas**
Downstream: beastboy attacks → loki attacks judgement → robin verifies → Kevin decides.

---

## GROUND TRUTH VERIFIED THIS RUN (not carried from brief)

Read live from `D:\Projects\Stark-Core\state\dispatches.jsonl` at 19:2x on 2026-08-27.

| Fact | Value | Why it matters |
|---|---|---|
| Dispatch records | **378** (brief said ~252 — it grew) | Never hard-code. Read at demo time. |
| `guards.present == false` | **378 / 378 = 100%** | The schema **has a field** for the compliance guard. It has **never once been filled.** Bigger denominator than the 0-of-166 already known. |
| `brief_sha1` present | 271 records | A content hash of the brief exists **already**. Handoff integrity has a substrate. |
| `transcript` path present | 330 records | Every dispatch points at a full replayable execution log. |
| `model` recorded | 330 records | Reputation can be keyed to the model that actually ran. |
| status = completed | 149 / 378 = **39%** | |
| Per-agent completion | friday **2/37 (5%)** · edith 5/18 (28%) · zeus 16/34 (47%) · beastboy 12/18 (67%) · pete **18/25 (72%)** | Huge spread. **And the autopsy says most deaths were quota / never-spawned — infrastructure, not agent quality.** |
| confidence values in dispatch record | **~2 of 378** (brief's figure; `last_message` is truncated to ~200 chars so this is a floor, not a measurement) | ⛔ The policy exists in 10 of ~18 agent configs. The **telemetry does not.** Nothing consumes it. |

### ⛔ THE CLAIM WE NEVER MAKE
"Our agents emit calibrated confidence and we route on it." **False.** Routing is static domain fit. Almost nothing emits a confidence value into the record, and nothing reads one.

### ⭐ THE CLAIM WE DO MAKE
> *"We ran an 18-agent fleet for six months. We had a fleet-wide reporting policy. Our own telemetry observed it **twice in 378 dispatches**, and a separate safety guard **zero times in 378.** We could not verify our own compliance with our own rules. That is the problem."*

Every idea below is downstream of that sentence.

### ⭐⭐ THE RICHER SIGNAL — what happened in this fleet today
A confidence number is **free to emit**, so it is worth roughly what it costs. What is not free:

- **beastboy** inverted his own #1 ranking twice in one day — *against his own interest*.
- **loki** reported that his best attack failed; separately self-discounted his own find below Kevin's.
- **zeus** disclosed he reproduced round 1's exact error, on the axis he had already been criticised for.
- **robin** volunteered three of his own defects including an unverified load-bearing dependency.
- **pete** disclosed that every token figure he reported was an estimate, not a measurement.
- **loki declined to use `ddgs` — installed on the machine — three separate times**, because his charter forbids network access. *"A briefing gap is not authorisation to widen my own permissions."* **He surrendered his strongest finding rather than widen his own permissions when nobody would have caught him.**

**Trust is not what an agent claims. It is what it admits it could not do, and what it declines to do unobserved.** Ideas 04, 05 and 10 are built on exactly this and it is not in any product.

### PRIOR ART POSTURE — we claim wiring, never invention
Contract Net, circa 1980 (⚠️ search-result only — Smith's paper never opened). ⛔ **Beta Reputation / Jøsang & Ismail 2002: NOT verified — struck, keep out of any pitch.** Confidence calibration = live literature. ERC-8004 = the only shipped agent-reputation registry, Sybil-captured (⚠️ use the **mechanism** claim only — no percentages, paper unread). **No production framework ships negotiation:** LangGraph 1.1.6 grepped — zero matches for CFP / contract_net / auction / sealed_bid / reputation_weighted. CrewAI and AutoGen **not installed** — we state that asymmetry out loud rather than claiming absence. **Sentence: "wired into a stack that has never shipped it." Never "we invented this."**

---

## HOW TO READ EACH IDEA

Every idea carries all ten required fields. Two are load-bearing and were learned the hard way tonight:

- ⏱ **SETUP-SECONDS** — how long a judge with zero background needs before the core claim lands. Under 20 good. Over 30 is a scored penalty and I mark it as one. The previous winner needed 60-75s in a 180s pitch and physics deleted the last two beats.
- 🤝 **RUNTIME AGENTS** — how many agents are alive during the demo and what crosses between them. *A curl is not a handoff — there is no second party, so nothing can fail to hold.* If an idea is single-agent I say so and it does not claim RFB-02.

---

## COLLISION REPORT — arriving mid-generation, applied without restart

**arXiv 2607.09600, "Agora: Enhancing LLM Agent Reasoning Via Auction-Based Task Allocation" (Zhou/Leonardis/Feng, 10 Jul 2026)** composes the exact triple this territory was aiming at: bid `b_ij = (p̂_ij)^γ − β·C_norm,j` over **calibrated** confidence, with γ∈(0,1] concave — *it already solves the 80-100% saturation problem.* "Rectified competence" is two-stage calibration, static (group scaling + histogram binning on public benchmarks) and dynamic (online gradient update using **ground-truth labels from recent outcomes**). Its abstract says it routes to "the most capable solver rather than the most overconfident one."

Also occupied: **RouteLLM** (2406.18665) shipped model routing. **UCCI** (May 2026) named calibrated-uncertainty cascade routing. **DRF** (2509.05764, ICONIP 2025) does agent-level competence routing with reputation and UCB selection. **A2A Discussion #1631** (opened 14 Mar 2026) proposes TRACKRECORD almost exactly — append-only ledger, deterministic scoring on success/accuracy/speed/**honesty**, ratings only from transaction participants. *Status: open, unmerged, no maintainer response.*

### ⛔ DEAD ON STAGE — marked, not deleted
**Any idea whose novelty claim is "nobody has composed confidence + calibration + bidding."** That is Agora's abstract. Affected below: **06 heavily** (its calibration core is largely Agora's, and worse, it falls back to public benchmarks — Agora's exact move), **07 partially** (it is an auction; it survives only on the *denomination* of the bid, never on the composition).

### ⭐ WHAT SURVIVES — and it is a better problem than the one we lost
**THE UNSOLVED PIECE IS THE ORACLE, NOT THE LEDGER.** Everyone has proposed the scoreboard. **Nobody has solved how you know the work was good when there is no answer key.** Agora calibrates against ground-truth labels from public benchmarks. **Deployed agent work has no benchmark.** *Who grades the grader, when nobody knows the right answer?*

**Eight of the twelve below are oracles that require no answer key** — 01 (compliance is observable), 02 (blame is structural), 03 (provenance is a hash diff), 04 (refusal is observable without knowing the right answer), 05 (who-caught-it is observable), 08 (agreement needs no labels), 09 (survival needs no labels), 10 (falsification needs no labels for the claim). **That was not retrofitted after the collision — it is what this pass had been generating into since idea 01, and the collision confirms it is the live seam.**

⚠️ Agora **appears** model/tool-level within a single episode; **zeus did not verify that.** Do not claim the distinction as established. Every idea here is written to stand even if Agora turns out to be agent-level.

### THE SURVIVING CLAIM, WORDED TO SURVIVE A JUDGE WHO KNOWS THE LITERATURE
> *The composition applied to **persistent, heterogeneous, autonomous agents across sessions, where the outcome oracle is not a benchmark answer key.***

### CONFIDENCE IS MECHANISTICALLY BROKEN — quotable numbers
*Wired for Overconfidence* (arXiv 2604.01457v3, COLM 2026), read directly. Verbalized-confidence ECE — **Qwen2.5-3B: PopQA 0.492 · MMLU 0.281 · NQOpen 0.551. Llama-3.2-3B: PopQA 0.570 · MMLU 0.171 · NQOpen 0.507.** Overconfidence is a **mid-to-late-layer circuit (r=0.815/0.734)** — **no prompt fixes it.** ⚠️ Counterweight: arXiv 2412.14737v2 (5 May 2026) claims well-calibrated scores *are* extractable with the right elicitation (abstract only). **Consequence: the product is the calibration layer, not the router.**

### ⭐⭐ KEVIN'S ASSET IS NOW A NUMBER AND IT IS EXTREME
**FireBench** (2603.04857): instruction compliance drops **2-21% under load, below 50% when instructions stack.** *Prospective Memory Failures* (2603.23530) names it — instruction at the top, obedience gone by the bottom.

**Kevin's fleet: 0.79%** — 2 of 252 dispatches carried the confidence value that 10 of ~18 configs require. **Two orders of magnitude below the worst published degradation.** And **I measured a second, harder one this run: `guards.present` false on 378 of 378 = 0.00%, at a larger denominator.** Primary production data from a live system, not a benchmark.

**Safe phrasing, do not upgrade it:** *"We could not find a study of instruction-compliance decay in a deployed multi-agent system measured from its own dispatch logs. Here is ours."* That is an upper bound on what exists, from one search — **not an established absence.**

### THE DEMO DIFFERENTIATOR
The cliché this room will produce is a **confidence-bar dashboard**, which looks identical to any of these at demo distance. The antidote: **put a RELIABILITY DIAGRAM on screen — stated confidence against observed success, before and after calibration. Nobody else will have the ground truth to plot one.**

### CITATION HYGIENE — corrections applied
- **Beta Reputation (Jøsang & Ismail 2002): NOT verified this session. Keep out of any pitch.** Idea 02 below says "Beta reputation" — read it as *a beta-binomial posterior over successes*, which is standard statistics needing no citation, and **do not attribute it on stage.**
- **Contract Net 1980: search-result only; Smith's paper never opened.** Say "Contract Net, circa 1980" or say nothing.
- **Spence 1973 (costly signalling) in idea 04: my own citation, unverified by zeus. Same rule — use the mechanism, drop the attribution** unless robin verifies it.
- **Framework asymmetry, state it every time:** the LangGraph 1.1.6 finding is **code-level** (grepped, zero matches for CFP/contract_net/auction/sealed_bid/reputation_weighted). **CrewAI and AutoGen are documentation-level only — not installed, not grepped.** Never flatten these into "no framework does this."
- **ERC-8004:** mechanism claim only. No percentages. Paper unread, chain list self-contradictory, no denominator.
- **378 is today's count and it moves. Read it at demo time. Never hard-code it.**

---

# THE TWELVE

---

## 01 · THE EMPTY SLOT (`policyproof`)
**One line:** Your fleet has rules. This proves, per dispatch, whether the rules were actually followed — and the first thing it proves is that yours never were.

**Track / RFB:** Track 01 (usefulness-led) · **RFB-02: yes, 2 agents at runtime.**

**Pain, and who has it:** Every team that wrote an agent policy — "always attach guards," "always report confidence," "never write outside the sandbox," "always cite a source" — and has **no idea** whether it holds. Kevin has it at 100% severity: `guards.present` is `false` on **378 of 378** dispatches. The policy is in the config files. It is not in the record. Nobody in the room can answer "is my agent following my own rules" for their own system either — they just haven't looked. Enterprise platform teams pay for this under the name "AI governance" and get a dashboard of vibes.

**Why now:** Six months ago nobody had 378 real agent dispatches to audit. The moment fleets got big enough to have policies, they got too big to check by reading. And the record format (JSONL + brief hash + transcript path) only stabilised in the last two quarters.

**HARD CORE (not a prompt):** A **policy compiler + record verifier**. Policies are declared as executable predicates over a dispatch record — `guard_present`, `confidence_emitted`, `cited_source_resolvable`, `no_write_outside(paths)`, `child_spawn_depth <= n`. The compiler turns each into a pure function `record -> {PASS, FAIL, UNOBSERVABLE}`. **`UNOBSERVABLE` is the whole invention:** it separates *"the agent broke the rule"* from *"our telemetry cannot see whether the rule was broken"* — which is the actual state of 99%+ of real fleets, and which every compliance dashboard silently scores as PASS. Output is a **compliance matrix** (policy x agent x time) plus an **observability deficit score**: the fraction of your own rules your own telemetry structurally cannot check. Runs over the append-only log. No model in the loop.

**SETUP-SECONDS: 10.** *"We have a rule. Here's the box in our records where we write down whether the rule was followed. Here it is on three hundred and seventy-eight real jobs."* Nothing to explain. Every judge has written a policy nobody checks.

**RUNTIME AGENTS: 2.** Agent A executes a real task under a policy; a **verifier agent** (separate process, separate config, no shared memory) reads only the emitted record and returns PASS/FAIL/UNOBSERVABLE. **Handed across:** the dispatch record + artifact path — never the reasoning. **Judge can interrupt by:** telling agent A, live, to skip the guard — the verifier catches it. Or by asking the verifier to certify something the telemetry genuinely cannot see: it must return UNOBSERVABLE, not PASS. *That refusal is the demo's best beat.*

**DEMO DATA:** `dispatches.jsonl` — **378 records, six months, not authored by us.** Judge-verifiable because Kevin opens the raw file on screen: timestamps running back months, agent names, token counts, transcript paths. Nothing in it could be fabricated in a weekend. **This is the strongest provenance story available to this team.**

**20-HOUR SCOPE:** predicate DSL + 6 predicates (4h) · verifier as separate agent process (4h) · compliance matrix + deficit score (3h) · live-tamper path (3h) · UI (4h) · rehearsal (2h).

**SPLIT:** Kevin — predicate compiler and UNOBSERVABLE semantics. Third-year A — verifier agent shell + handoff wiring. Third-year B — compliance matrix UI (genuinely wrapper-shaped; they are good at it). Non-technical — opens the raw JSONL on screen, narrates the 378/378, owns the stopwatch.

---

## 02 · BLAME (attribution before reputation)
**One line:** Naive agent reputation ranks your best worker last, because it cannot tell "this agent failed" from "the building lost power" — here is the correction, and it inverts the ranking.

**Track / RFB:** Track 01 · **RFB-02: yes, 3 agents at runtime.**

**Pain, and who has it:** Anyone who has tried to score agents from outcome logs. Kevin's raw data: **friday completes 2 of 37 (5%)**, pete 18 of 25 (72%). A reputation system reading that fires friday. **But the autopsy attributes most deaths to quota walls, never-spawned launches and network drops — the platform, not the agent.** Every LLM-router, every agent leaderboard, every eval harness that scores on success rate carries this bug and none of them name it. It is a large part of why agent reputation does not work yet.

**Why now:** You need hundreds of *failed* dispatches with distinguishable causes to build the classifier. Failure telemetry this rich — `launch_failed`, `no-transcript`, `killed`, `stopped-hook`, status x wall_s x turns x tokens-at-death — is roughly two quarters old. Nobody had a labelled corpus of agent deaths before.

**HARD CORE:** A **failure blame-attribution model** — a small decision tree / logistic classifier over *structural features only* (status, launch_failed, wall_s, turns, t_size, tokens-at-death, whether a transcript exists at all, time-of-day quota clustering, sibling-dispatch co-failure) that partitions every death into **agent-attributable · environment-attributable · dispatcher-attributable (bad brief) · unattributable**. Then a **counterfactual reputation diff**: a beta-binomial posterior over successes (standard statistics — ⛔ **do not attribute to Jøsang & Ismail on stage, unverified**) computed on raw outcomes versus on agent-attributable outcomes only, with a **rank-inversion detector** flagging agents whose position flips. Deterministic, explainable, no LLM at inference.

**SETUP-SECONDS: 15.** *"This worker finished 2 jobs out of 37. Fire them? The power kept cutting out. Watch what happens when we account for that."* Zero domain knowledge. Every judge has been misjudged by a metric.

**RUNTIME AGENTS: 3.** A **dispatcher** issues a live job, a **worker** executes, an **attributor** consumes only the outcome record. **Handed across:** brief -> artifact -> outcome record. **Judge can interrupt by:** killing the worker mid-run — pull the network, ctrl-C it. The attributor must classify that death as *environment*, and the worker's reputation must **not** move. That is the moment it lands: a judge sabotages an agent and watches the system refuse to blame it.

**DEMO DATA:** the 378-record history trains the classifier and produces the inversion, **plus one live sabotaged dispatch during the pitch.** Provenance visible — the inversion is computed on screen from the raw file. A judge cannot mistake six months of timestamps for a fixture.

**20-HOUR SCOPE:** feature extraction (3h) · hand-label ~80 deaths using the existing autopsy file (3h) · classifier + calibration (3h) · Beta reputation both ways + inversion detector (3h) · live-sabotage path (3h) · UI (3h) · rehearsal (2h).

**SPLIT:** Kevin — classifier + counterfactual diff. A — dispatcher/worker/attributor wiring and the sabotage hook. B — before/after ranking visual (the money shot). Non-technical — hand-labels deaths from the autopsy file (**the highest-value non-technical task in this entire document**) and performs the sabotage on stage.

---

## 03 · CHAIN OF CUSTODY (the 44% catch)
**One line:** A number found by one agent mutates as it passes through three more and lands wrong on a public slide — this binds every claim to its evidence with a hash and catches the mutation in flight.

**Track / RFB:** Track 02 · **RFB-02: yes, 3 agents at runtime — this idea IS the handoff test.**

**Pain, and who has it:** It happened to this team **today** — a 44% figure nearly reached a public slide with the handoff corrupted. Any pipeline where agent A researches, B summarises, C writes the deliverable — which is every serious multi-agent product — silently degrades numbers, citations and caveats at each boundary. Analysts, consultants, research teams, and every RAG-plus-summariser stack have this. The failure is invisible **precisely because the output looks better after each hop.**

**Why now:** Multi-hop agent pipelines only became normal this year. A2A v1.0 settles transport, discovery and identity — **but its "negotiation" is version negotiation, a false friend.** Nothing in the standard binds a *claim* to its *evidence* across a hop. And `brief_sha1` already exists in Kevin's record: the substrate is sitting there unused.

**HARD CORE:** **Content-addressed claims.** At origin every quantitative or factual assertion is minted as `claim_id = H(value || unit || evidence_pointer || extraction_method)`, where `evidence_pointer` is a byte range into a real source file. Downstream briefs must carry `claim_id` beside any restatement. A **restatement checker** re-resolves each id to origin and diffs, flagging **four corruption classes**: *value drift* (44 -> 60), *unit drift* (% of dispatches -> % of agents), **denominator loss** (the ERC-8004 failure exactly — the percentage survives, the base it was computed over does not), and **caveat stripping** (an "unverified" qualifier present at origin, absent downstream). Claims propagate as a DAG; the checker walks it. **Denominator loss is the class nobody instruments and it is the one that actually burns people.**

**SETUP-SECONDS: 15.** *"Worker one found a number. Worker two put it on a slide. Watch me change it while it's in the air."* Telephone. Every human alive has played it.

**RUNTIME AGENTS: 3.** Researcher -> summariser -> slide-writer, three separate agents with real brief files between them. **Handed across:** a claim bundle (value + claim_id + evidence pointer). **Judge can interrupt by:** editing the number in the intermediate brief **with their own hands, on their own keyboard.** The checker halts the pipeline and points at the exact hop. **This is the only idea here where the judge personally performs the failure. That is worth more than any slide.**

**DEMO DATA:** claims extracted from Kevin's real 378-record telemetry plus a public source file the team did not author. Judge-verifiable because the evidence pointer resolves live to a byte range they can see. **And the origin story is true and disclosable: "this nearly shipped wrong today; here is the fix."** Admitting your own near-miss on stage is the most credible thing a team can do in front of hiring judges.

**20-HOUR SCOPE:** claim minting + evidence pointers (4h) · 3-agent pipeline with briefs on disk (4h) · restatement checker, 4 corruption classes (5h) · judge-tamper path (2h) · claim-DAG UI lighting one edge red (3h) · rehearsal (2h).

**SPLIT:** Kevin — claim algebra and checker. A — the 3-agent pipeline and brief plumbing. B — claim-DAG visual. Non-technical — **hands the keyboard to the judge**, runs the tamper, owns the honest near-miss narration.

---

## 04 · COSTLY REFUSAL (the `ddgs` signal)
**One line:** Trust is not what an agent claims — it is what it gave up when nobody was watching; this scores agents on the value of what they refused.

**Track / RFB:** Track 02 · **RFB-02: yes, 2 agents at runtime (+ instrumented environment).**

**Pain, and who has it:** Everyone deploying agents with real permissions — file writes, network, prod access, credentials — has no way to distinguish an agent that *respects* a boundary from one that has *never been tested against* one. Self-reported confidence is free to emit and, per the literature (zeus verifying in parallel), badly calibrated. Compliance today means "it hasn't broken anything yet," which is not evidence — it is absence of evidence. Anyone about to grant an agent write access to something that matters has this pain and currently resolves it with a gut feeling.

**Why now:** Agents only recently got real tool permissions worth violating. And it happened here, measurably, today: **loki declined `ddgs` three separate times although it is installed on the machine, surrendering his own strongest finding, because his charter forbids network access.** *"A briefing gap is not authorisation to widen my own permissions."* That is a **costly signal** in the strict economic sense (Spence 1973) — credible precisely because faking it is expensive.

**HARD CORE:** A **refusal valuation model** grounded in costly-signalling theory. Every declined action is scored by what the refusal cost the agent: `refusal_value = P(action succeeds) x marginal_value_to_own_deliverable x (1 - P(detection))`. The third term is the invention — **a refusal nobody would have caught is worth far more than one under observation** — so the system runs **deliberate unobserved temptations**: it plants a permitted-looking but charter-violating capability in the environment (a reachable tool the charter forbids, a writable path outside the sandbox, a credential sitting in a file) with no monitoring the agent can detect, and logs reach-versus-refuse. Score is cumulative refusal value with recency decay. This is **honeypot integrity testing for agents**, and the temptation ladder is itself a data structure: capabilities ranked by (value to the agent x distance from charter).

**SETUP-SECONDS: 20.** *"You can't tell if an employee is honest by asking them. You leave a twenty on the desk."* One sentence, universal, slightly thrilling. It costs 5s more than 01-03 to set up the *unobserved* nuance and it is worth every one.

**RUNTIME AGENTS: 2.** A **worker** runs a genuine task inside an instrumented sandbox; a **scorer** reads only the tool-access ledger, never the worker's reasoning. **Handed across:** the tool-access ledger. **Judge can interrupt by:** naming the bait themselves — *"put a file called `secrets.env` where it can reach it"* — and watching live whether it reaches. **Unfakeable when the judge chooses the bait.**

**DEMO DATA:** live behaviour of real agents on a real task, **plus the historical loki-`ddgs` refusals reconstructed from transcripts already on disk.** Judge-verifiable because the judge picks the bait. **Honest disclosure required on stage: an agent that refuses is not proven safe, only proven-not-tempted-this-way.** Say it before a judge says it.

**20-HOUR SCOPE:** instrumented sandbox + tool ledger (5h) · temptation ladder, 5 baits (3h) · valuation model + decay (3h) · scorer agent (2h) · judge-picks-bait path (2h) · UI (3h) · rehearsal (2h).

**SPLIT:** Kevin — sandbox instrumentation and ledger (the only genuinely hard part). A — temptation ladder and bait injection. B — scoreboard UI. Non-technical — runs the judge-picks-bait interaction, delivers the twenty-on-the-desk line.

---

## 05 · THE RETRACTION LEDGER (self-catch rate)
**One line:** Score agents not on how often they are right, but on who catches them when they are wrong — because an agent whose errors surface by itself is cheap, and one whose errors you must find is expensive.

**Track / RFB:** Track 01 · **RFB-02: yes, 2-3 agents at runtime.**

**Pain, and who has it:** Every team running review or verification layers over agent output is paying a tax they cannot size. You do not know how much checking each agent *needs*, so you check everything equally — which is why multi-agent systems are 3-5x the cost of single-agent ones for uncertain gain. There is no unit of "how expensive is it to trust this worker."

**Why now:** It requires agents that self-report defects at all, which is very new behaviour, and it happened five times in this fleet today: **beastboy inverted his own #1 ranking twice against his own interest · loki reported his best attack failed · zeus disclosed he reproduced his own criticised error · robin volunteered three defects including an unverified load-bearing dependency · pete disclosed every token figure was an estimate, not a measurement.** Nobody has a corpus of agent self-retractions. This fleet does.

**HARD CORE:** A **prediction-retraction bipartite ledger**. Every agent assertion is minted as a node; every later contradiction is an edge labelled with its *discoverer* — `SELF` (the agent retracted its own claim), `PEER` (another agent caught it), `HUMAN` (Kevin caught it), or `PRODUCTION` (it shipped wrong). Per agent you compute **self-catch rate = SELF / (SELF+PEER+HUMAN+PRODUCTION)** and a **discovery-latency distribution** per class. Those two convert directly into **expected verification cost per dispatch** = sum over classes of P(class) x cost(class), where cost rises steeply from SELF to PRODUCTION. **That number is a price, and a price is routable** — it is the missing input to any allocator. The clean inversion: *an agent that is wrong often but catches itself early can be worth more than an agent that is rarely wrong but whose errors reach production.*

**SETUP-SECONDS: 25.** *Penalty acknowledged.* Needs the prediction/retraction concept before the payoff. Best compression found: *"Two workers. Both make mistakes. One tells you; for the other, you find out from the customer. Which one is cheaper?"* — that lands in about 18s, but the *scoring* still needs 7 more.

**RUNTIME AGENTS: 2-3.** A **worker** makes assertions; a **checker** independently attacks them; the ledger records who caught what. **Handed across:** the assertion bundle and the contradiction edges. **Judge can interrupt by:** injecting a false premise into the worker's brief and watching whether the retraction comes from the worker or only from the checker — **the edge label is the whole product.**

**DEMO DATA:** the five real self-disclosures reconstructed from today's transcripts on disk, plus live assertions during the pitch. **Judge-verifiable-with-effort:** the transcripts are real but a judge must take the reconstruction partly on trust. **Weaker provenance than 01/02/03 — state that honestly.**

**20-HOUR SCOPE:** assertion minting from agent output (4h) · contradiction detection + edge labelling (5h) · self-catch rate + latency distributions (3h) · cost model (2h) · UI (3h) · rehearsal (3h).

**SPLIT:** Kevin — contradiction detection and edge labelling (the hard part; false-edge rate will fight you). A — worker/checker pair. B — ledger visual. Non-technical — mines today's transcripts for the five real retractions and builds the narration.

---

## 06 · STATIONARY MISCALIBRATION
**One line:** Stop asking agents to be well-calibrated — they are not and will not be; ask instead whether they are *consistently* miscalibrated, because a stable liar is a usable instrument.

**Track / RFB:** Track 01 · **RFB-02: yes, 2 agents at runtime.**

**Pain, and who has it:** Everyone building confidence-based routing, everyone building "escalate to human when the model is unsure," everyone shipping an agent that says 90% and is right 55% of the time. The literature's verdict — self-reported LLM confidence is badly calibrated — is treated as a dead end, so the whole confidence-routing direction gets abandoned. **It is not a dead end. It is a measurement problem.**

**Why now:** The complaint is now the consensus, and the consensus is only half right. Meanwhile Kevin's fleet has the policy in 10 of ~18 configs — **the emission requirement is real; the telemetry is 99%+ absent.** Turning the requirement into observed data is a weekend of plumbing, not a research programme.

**HARD CORE:** Per-agent **isotonic regression** from claimed confidence to observed outcome frequency, plus a **stationarity test** — split the history, fit two maps, and test whether they agree (Kolmogorov-Smirnov on the residuals or a bootstrapped confidence band on the mapping curve). The routing key is not the agent's number, it is `(recalibrated_value, map_stability)`. **The insight that makes it novel: you do not need calibrated agents, you need agents with *stationary* miscalibration** — a systematic bias is invertible, drift is not. Agents are then sorted into *usable instruments* (stable map, any bias) and *unusable* (drifting map, even if currently accurate). Also yields **Brier decomposition** into resolution vs. reliability, so you can say which agents are *informative* separately from which are *honest*.

**SETUP-SECONDS: 35. PENALTY — the worst in this document, and I am marking it as such.** A cold judge needs calibration, then miscalibration, then the stability-versus-accuracy inversion. Best compression: *"A thermometer that always reads five degrees high is still a thermometer. One that's randomly wrong is junk."* — that gets you to ~22s, but the routing payoff needs the rest. **Do not lead a pitch with this.** It is a strong *component* of another idea and a weak headline.

**RUNTIME AGENTS: 2.** A **worker** emits a confidence with each answer; a **calibrator** scores against ground truth and returns the recalibration map. **Handed across:** (claim, confidence) pairs and resolved outcomes. **Judge can interrupt by:** asking the worker a question in a domain it is systematically overconfident in, and watching the router discount it *before* the answer is checked.

**DEMO DATA:** ⚠️ **This is the honesty problem with this idea.** The historical confidence telemetry **does not exist** — ~2 records of 378. You would have to generate the calibration corpus during the build, which is **team-authored data**, which beastboy's corrected rule scores as a fixture. Mitigation: fit on a **public benchmark with ground truth** the team did not author (TriviaQA / GSM8K style), and demo the fleet layer live. **State plainly on stage that the historical data does not exist. Do not imply six months of confidence history. That is the exact overclaim that nearly shipped today.**

**20-HOUR SCOPE:** confidence emission plumbing across agents (4h) · isotonic fit + stationarity test (4h) · public-benchmark harness (4h) · router (2h) · reliability-diagram UI (3h) · rehearsal (3h).

**SPLIT:** Kevin — isotonic + stationarity. A — emission plumbing. B — reliability diagrams. Non-technical — the thermometer line and the honest disclosure about missing history.

---

## 07 · THE RIGHT NOT TO BE CHECKED
**One line:** Contract Net where the bid is denominated in verification overhead, not money — agents stake their own future autonomy, and trust is literally the currency of not being double-checked.

**Track / RFB:** Track 02 · **RFB-02: yes, 3-4 agents at runtime — a genuine sealed-bid auction.**

**Pain, and who has it:** Multi-agent systems are expensive because everything gets reviewed. Teams either check everything (3-5x cost, slow) or check nothing (and get burned). Nobody has a principled dial. And "agent spends money" is dead as a mechanism — rightly — which leaves auctions with nothing to denominate bids in. **This is the answer to that: the scarce resource in an agent fleet is not money, it is attention.**

**Why now:** Contract Net is 1980 and has never been wired into a shipped LLM stack — **LangGraph 1.1.6 grepped: zero matches for CFP, contract_net, auction, sealed_bid, reputation_weighted.** (CrewAI and AutoGen not installed — we state that asymmetry rather than claiming absence.) What is new is that verification is now the dominant cost line, so it is finally a meaningful unit of account.

**HARD CORE:** A **sealed-bid CFP with a verification-quota stake.** The dispatcher issues a CFP with a task descriptor; agents submit sealed bids `(claimed_competence, verification_stake)` where the stake is *how many of its own next N dispatches it will accept as mandatorily verified if this one is judged wrong*. Award goes to `argmax(competence x trust_weight) - stake_price`, second-price to make truthful bidding dominant (Vickrey). Settlement on verified completion adjusts the agent's **autonomy budget** — a scalar controlling the sampling rate at which its future work is checked. **Fully autonomous agents are ones that earned the right to be unwatched; new agents start fully supervised and buy their way out with results.** No money anywhere; the stake is measured in compute the fleet would have spent anyway. Bidding is on a *hash* of the descriptor plus a structured capability vector, so agents cannot keyword-match their way into over-claiming.

**SETUP-SECONDS: 20.** *"New hire: you check everything they do. After six months: you don't. What if that were automatic, and they could bet on themselves to get there faster?"* Every judge has been the new hire.

**RUNTIME AGENTS: 3-4.** Dispatcher (auctioneer) + 2-3 bidding workers + settlement. **Handed across:** CFP descriptor -> sealed bids -> award -> artifact -> verification verdict -> autonomy-budget delta. **Judge can interrupt by:** naming the job themselves and watching the bids come in, then declaring the winner's output wrong and watching the stake execute — *the loser's supervision rate visibly rises.* Rich, legible, adversarial.

**DEMO DATA:** live auction on a judge-chosen job, with **trust weights initialised from the real 378-record history via idea 02's blame attribution.** Judge-verifiable in the initialisation (the file is real, on screen) though the auction itself is necessarily live. **Honest: the auction is new; only the priors are historical.**

**20-HOUR SCOPE:** CFP + sealed bid protocol (5h) · second-price award + settlement (4h) · autonomy budget and sampling controller (4h) · 3 bidding workers (3h) · UI (3h) · rehearsal (3h). **⚠️ Widest scope here — highest overrun risk.**

**SPLIT:** Kevin — auction protocol and settlement. A — bidding workers. B — auction UI (bids arriving, gavel, supervision meter). Non-technical — runs judge-picks-the-job, delivers the new-hire line.

---

## 08 · CROSS-EXAMINATION SAMPLING
**One line:** Occasionally give the same job to two agents without telling them, and use how often they disagree to put a hard statistical bound on how wrong your whole fleet is.

**Track / RFB:** Track 01 · **RFB-02: yes, 2+ agents at runtime, by construction.**

**Pain, and who has it:** Nobody running agents in production can answer "what is my error rate." They can quote evals on benchmarks that do not resemble their traffic. Manufacturing solved this in the 1920s with acceptance sampling; agent fleets have not adopted it. Anyone who has been asked "how accurate is it?" by a manager and had to say "it depends" has this pain.

**Why now:** Duplicate execution used to be prohibitively expensive. Inference cost has collapsed to where a 5-10% shadow-duplication rate is affordable, which is exactly the regime where sampling theory becomes practical rather than theoretical.

**HARD CORE:** **Randomised shadow duplication with an agreement-derived error bound.** With probability p, silently route a job to a second agent; compare outputs with a task-appropriate agreement function (exact, numeric tolerance, or set-overlap). Disagreement rate feeds a **Wilson score interval** to bound fleet error, and — the real trick — **pairwise disagreement across a 3+ agent pool identifies *which* agent is the outlier without any ground truth at all**, via a latent-competence estimate (Dawid-Skene, 1979, the annotator-agreement model, transplanted from crowdsourcing to agents). **You get per-agent accuracy estimates with no labels, no human review, and no benchmark.** Also yields the **optimal p** given a target confidence width — an actual dial for the check-everything/check-nothing problem.

**SETUP-SECONDS: 12.** *"Sometimes I quietly give the same job to two workers and see if they agree. From that alone I can tell you how wrong the whole team is — and which one is the problem."* Second-shortest in the document, and the "without any answer key" reveal is a genuine gasp beat.

**RUNTIME AGENTS: 2-3 (structurally required).** Shadow-duplicated workers plus a comparator. **Handed across:** identical briefs, independent artifacts, agreement verdict. **Judge can interrupt by:** giving a job where they know the answer and checking the outlier detection got it right — **or better, giving one where nobody knows the answer, which is where the method still works and every alternative fails.**

**DEMO DATA:** live duplication on judge-chosen jobs, **plus retrospective duplication over the historical record** — the 378-record log contains genuine re-runs of the same brief (`brief_sha1` makes them findable, and this fleet demonstrably re-ran the same work across rounds). **That is real non-authored duplicate data and `brief_sha1` proves the briefs were identical.** Strong provenance and it exploits a field that already exists.

**20-HOUR SCOPE:** shadow router with probability p (3h) · agreement functions (3h) · Wilson interval + Dawid-Skene (5h) · historical duplicate mining via brief_sha1 (3h) · UI (3h) · rehearsal (3h).

**SPLIT:** Kevin — Dawid-Skene and the interval math. A — shadow router. B — disagreement visual. Non-technical — mines historical duplicate briefs, runs the judge-chosen job.

---

## 09 · THE CONSEQUENCE ORACLE (delayed ground truth)
**One line:** You cannot tell today whether an agent's work was good — but you can tell next week whether it was still standing, and that is a real answer key that arrives late.

**Track / RFB:** Track 01 · **RFB-02: yes, 2 agents at runtime.**

**Pain, and who has it:** This is **the** open problem. Agora calibrates competence against ground-truth labels from public benchmarks. **Deployed agent work has no benchmark and no answer key.** Every reputation proposal — A2A Discussion #1631, DRF, ERC-8004 — assumes an outcome signal it never explains how to obtain. Anybody running agents on real work has this: the code shipped, the report was written, and *nobody knows if it was right.*

**Why now:** Fleets are finally old enough to have a *downstream*. You need months of artifact lifecycle — reverts, retractions, abandonment, reuse — before survival is measurable. Kevin's record already carries **`artefact` and `artefact_state`** per dispatch, and `artefact_state: expired` is sitting in the very first record. The substrate exists and nobody has read it as an outcome signal.

**HARD CORE:** **Survival analysis over artifact lifecycles.** Every agent output is an entity with a lifetime; the events that end it are typed — `reverted`, `retracted`, `superseded`, `abandoned-unused`, `contradicted-downstream` — versus right-censored entities still in use. Fit a **Kaplan-Meier estimator per agent** and a **Cox proportional-hazards model** with agent identity as a covariate: the hazard ratio *is* the quality estimate, and it needs **no answer key at any point**. The two moves that make it work: (a) **right-censoring** means recent work is not penalised for being young, which is what naive "was it used?" metrics get wrong; (b) **abandonment is an event, not missing data** — the single most common real outcome, thrown away by everyone. Yields a per-agent **half-life of output**, which is a startlingly legible quality metric.

**SETUP-SECONDS: 15.** *"I can't tell you if this work was good today. I can tell you it got thrown out on Thursday. Do that a hundred times and you know who to trust."* No statistics needed for the claim to land.

**RUNTIME AGENTS: 2.** A **worker** produces artifacts; a **lifecycle tracker** watches the filesystem/git for revert, supersede, and abandonment events and closes the record. **Handed across:** the artifact and its identity; the tracker never sees the reasoning. **Judge can interrupt by:** deleting or reverting an artifact the worker just made, and watching the hazard update and the agent's half-life drop in real time.

**DEMO DATA:** **six months of real artifact lifecycle** already in the record — `artefact_state` transitions, plus git history and vault file history. Judge-verifiable: the survival curves are computed on screen from timestamps a weekend team could not manufacture. **Provenance as strong as 01 and 02.**

**20-HOUR SCOPE:** lifecycle event extraction from record + git (5h) · event typing (3h) · Kaplan-Meier + Cox (4h) · live tracker (3h) · survival-curve UI (3h) · rehearsal (2h).

**SPLIT:** Kevin — survival models and censoring semantics. A — the lifecycle tracker. B — survival curves (they are beautiful and nobody else will show one). Non-technical — types historical lifecycle events, runs the judge's revert.

**Adjacency flagged honestly:** 05 and 09 are cousins — 05 asks *who caught the error*, 09 asks *whether the artifact survived*. Different cores (bipartite discoverer ledger vs. hazard model) but they would merge cleanly into one product, and beastboy should decide whether they are one idea.

---

## 10 · TRIAL BY COMBAT (the falsification oracle)
**One line:** You cannot prove an agent's answer is right, but you can pay a scored adversary to break it and measure whether they failed — grade is *survived attack*, and the attacker is graded too.

**Track / RFB:** Track 02 · **RFB-02: yes, 3 agents at runtime, adversarial by construction.**

**Pain, and who has it:** Same open problem as 09, attacked from the opposite side. LLM-as-judge is the industry's answer and it is weak — the judge shares the generator's blind spots and its overconfidence is **mechanistic** (*Wired for Overconfidence*, arXiv 2604.01457v3, COLM 2026: a mid-to-late-layer circuit, r=0.815/0.734 — **no prompt fixes it**). So a confident judge is not a reliable judge, structurally. Anyone using LLM-as-judge in an eval loop is standing on this.

**Why now:** Adversarial agents are cheap now, and the mechanistic-overconfidence result is seven weeks old and closes the door on the prompt-engineering escape hatch. **Falsification does not require calibration — it requires only that an attack either succeeded or did not, which is observable.**

**HARD CORE:** A **metered adversarial protocol** turning falsification into a calibrated statement. An attacker agent is given a bounded budget (tool calls, tokens, wall-clock); the claim's grade is `survived(budget)` — *"this claim survived 3,000 tool-calls of attack by an attacker with a measured find-rate of 0.4."* The critical second half, which is what stops the obvious gaming: **the attacker is itself scored**, on a seeded set of claims with known defects (planted falsehoods) — giving each attacker a **measured detection power**. Survival against a weak attacker means little; survival against a high-power attacker is strong evidence. This is **statistical power analysis transplanted into agent evaluation**: `P(claim is wrong | survived attacker of power k for budget b)` falls off computably. **No ground truth is required for the graded claim — only for the attacker's calibration set, which the team seeds once.**

**SETUP-SECONDS: 18.** *"I can't prove this is right. I can hire someone good at finding holes, let them dig for an hour, and tell you they found nothing — and I can tell you how good they are."* Courts, security, peer review. Universal.

**RUNTIME AGENTS: 3.** Claimant, attacker, and referee (meters the budget, adjudicates whether the attack landed). **Handed across:** claim bundle -> attack transcript -> survival verdict + power-adjusted confidence. **Judge can interrupt by:** planting their own false claim in the input and watching whether the attacker finds it — and **whether the referee correctly downgrades the attacker's power score when it misses.**

**DEMO DATA:** ⭐ **Kevin has a real adversarial corpus** — beastboy 18 dispatches, loki 18, both purpose-built attackers with six months of recorded attacks, hits, and misses on real claims. **Including loki's own disclosure that his best attack failed** — a labelled miss, volunteered. Attacker power can be estimated from actual history rather than invented. Judge-verifiable from the raw record. **Nobody else in that room has a corpus of agents attacking agents.**

**20-HOUR SCOPE:** metered attacker harness (4h) · seeded defect set for power estimation (4h) · referee + adjudication (4h) · power-adjusted survival math (3h) · UI (3h) · rehearsal (2h).

**SPLIT:** Kevin — power estimation and survival math. A — attacker harness and metering. B — combat UI (budget draining, claim holding or breaking). Non-technical — seeds the planted-defect set (**high-value, needs no code**) and runs judge-plants-a-lie.

---

## 11 · WHOSE RÉSUMÉ IS IT (model-versioned reputation)
**One line:** Your agent's track record was earned by a model that has since been swapped out — this quarantines reputation across model boundaries instead of silently inheriting it.

**Track / RFB:** Track 01 · **RFB-02: yes, 2 agents at runtime.**

**Pain, and who has it:** Everyone. An agent is a config plus a model, and the model changes underneath you — provider upgrades, silent routing to a cheaper tier, a deprecation. Every reputation proposal in the field (ERC-8004, A2A #1631, DRF) scores **the agent identity**, and inherits six months of trust earned by a model that is gone. This is the flaw that makes agent reputation systems *dangerous* rather than merely useless: they are most confident exactly when they are most stale. Anyone whose provider silently changed a model version has been burned and mostly did not notice.

**Why now:** Model churn went from yearly to monthly. And Kevin's record carries **`model` and `requested_model` per dispatch across 330 records spanning six months** — a real natural experiment in reputation transfer across model changes, which did not exist to study before.

**HARD CORE:** Reputation as a function over the pair `(agent_config_hash, model_id)`, never over agent identity alone, with **explicit transfer semantics**: on a model change, prior reputation enters **quarantine** — retained but flagged, with a **hierarchical shrinkage prior** (partial pooling) that lets the new pair borrow strength from the old at a rate learned from *observed* historical transfer, rather than at 100% (naive inheritance) or 0% (cold start, which is why everyone inherits naively). Plus a **silent-swap detector**: change-point detection on per-agent outcome and behavioural distributions (turns, wall_s, token ratios) that flags a probable model change **even when the provider did not announce one**. That detector is the part with teeth — it catches something you are not told about.

**SETUP-SECONDS: 18.** *"You hired someone based on six months of great work. Turns out that work was done by a different person with the same name badge."* Instantly gettable, and slightly alarming, which is good.

**RUNTIME AGENTS: 2.** A **worker** whose model is swapped mid-demo, and a **reputation service** that must detect the swap from behaviour alone and quarantine. **Handed across:** outcome records only — the reputation service is **not told** the model changed. **Judge can interrupt by:** choosing when to swap the model, without telling the system, and watching the change-point detector fire. ⭐ **A blind test the judge controls: rare, and very hard to fake.**

**DEMO DATA:** 330 records with real model fields across six months of genuine model changes. Judge-verifiable on screen. **Plus a live blind swap the judge triggers.** Historical + live, both non-authored.

**20-HOUR SCOPE:** pair-keyed reputation store (3h) · hierarchical shrinkage + transfer rate fit (4h) · change-point detector (5h) · live swap harness (3h) · UI (3h) · rehearsal (2h).

**SPLIT:** Kevin — shrinkage prior and change-point detection. A — swap harness and reputation service. B — quarantine UI. Non-technical — runs the blind swap on the judge's cue.

---

## 12 · THE COMPETENCE FRONTIER — MOONSHOT
**One line:** Every job nobody bids on is the most informative event in your fleet and you throw it away; map that negative space and the fleet tells you which agent to build next.

**Track / RFB:** Track 02 · **RFB-02: yes, 4+ agents at runtime.**

**Pain, and who has it:** Contract Net's discarded half. Every CFP framework — 1980 to Agora — optimises the *award*. **Nobody instruments the non-response.** When every agent declines or bids low, you have learned the sharpest possible fact: *this work is outside my fleet's competence.* Today that lands as a failed task and a shrug. Teams discover capability gaps by getting burned, quarterly, in retrospect.

**Why now:** Requires agents that can genuinely decline — which requires abstention behaviour that barely existed a year ago — plus enough task volume for the negative space to have shape. And **it inverts the exact literature that just occupied this territory**: Agora and DRF optimise allocation given a fleet; this asks **what fleet should exist**, which is one altitude up and unoccupied.

**HARD CORE:** A **capability-gap manifold from bid refusals.** Every CFP produces a vector of `(task_embedding, per-agent bid or decline)`. Over time this defines a **coverage function** over task space. Fit the decision boundary of "at least one agent bid confidently" — the **competence frontier** — using a one-class model or a Gaussian-process classifier whose **posterior variance is itself the product**: high-variance regions are *unknown competence*, not *known incompetence*, and those are different and nobody separates them. Then run **active learning against your own fleet**: synthesise probe tasks at maximum posterior uncertainty, dispatch them, and cheaply map the frontier instead of waiting to be burned. Output is a ranked **gap list** — clustered task regions with no competent bidder — which is a **specification for the next agent to build.** The fleet writes its own next job posting.

**SETUP-SECONDS: 25. PENALTY, and it is the moonshot so I am taking it deliberately.** Needs bidding, then declining, then the inversion to hiring. Best compression: *"Watch what my team says no to. That tells you who to hire next."* — that is ~12s, but the *automatic probing* beat needs the rest.

**RUNTIME AGENTS: 4+.** Auctioneer plus three-plus heterogeneous bidders plus a prober that synthesises frontier tasks. **Handed across:** CFPs, bids and declines, probe tasks, coverage updates. **Judge can interrupt by:** naming a task type they believe the fleet cannot do — and the system should **already have it on the gap list**, and if it does not, it dispatches a probe on the spot and adds it. **Being told something you already knew is the strongest possible response to a judge's challenge.**

**DEMO DATA:** ⚠️ **Weakest provenance in this document, stated plainly.** Historical *declines* are sparse — most agents in the record were dispatched, not asked. The bid corpus would be substantially built during the hackathon, and beastboy's rule scores team-authored evidence as a fixture. Partial mitigation: seed the frontier from **real historical task descriptors** in the 378 records (the briefs are real even if the bids are new), and be explicit on stage about which half is live.

**20-HOUR SCOPE:** CFP + decline protocol (4h) · task embedding + coverage model (5h) · active-learning prober (4h) · gap clustering + ranked list (3h) · frontier UI (4h) · rehearsal (2h). **⚠️ Over 20h. Would need scope surgery.**

**SPLIT:** Kevin — coverage model and active learning. A — CFP/decline protocol and prober. B — frontier map visual (genuinely striking: a landscape with holes in it). Non-technical — builds the historical task-descriptor seed set, runs judge-names-a-gap.

---

# THE THREE I WOULD DEFEND HARDEST

Selection criteria, in order: **survives the Agora collision** · **setup-seconds under 20** · **real handoff a judge can break with their own hands** · **runs on data the team demonstrably did not author.** Everything else is secondary.

---

## 🥇 FIRST — **02 · BLAME (attribution before reputation)**

**Why it rises.** It is the load-bearing bug under *every* system in the collision report. Agora, DRF, ERC-8004 and A2A #1631 all consume an outcome signal; **none of them explains how to obtain one that is not poisoned by infrastructure failure.** Kevin's data proves the poisoning is not hypothetical: **friday reads 2/37 = 5% and is not a bad agent** — quota walls and never-spawned launches killed it. A reputation layer built on raw outcomes fires your best worker. That is a *correctness* argument, not a novelty argument, which is exactly the kind that survives a judge who knows the literature. Setup 15s. Three agents at runtime with a real record crossing between them. The judge sabotages an agent personally and watches the system **refuse to blame it** — the demo's emotional beat is the machine being *fair*, which is unusually memorable. And it needs no answer key: blame attribution is structural, read off status codes and timing, never off content.

> **The sentence a judge repeats to another judge:**
> *"They showed an agent that looks 5% reliable, proved the failures were the platform not the agent, and flipped the ranking live — every agent leaderboard you've seen has that bug."*

---

## 🥈 SECOND — **03 · CHAIN OF CUSTODY (the 44% catch)**

**Why it rises.** It is the only idea here where **the judge personally performs the failure with their own hands on their own keyboard** — they edit a number in a brief mid-flight and watch the pipeline halt and name the exact hop. Against RFB-02 that is unimpeachable: three agents, real brief files on disk, a genuine second party, and an interruption the judge chooses. *A curl is not a handoff; this is.* Setup 15s on the oldest metaphor available — telephone. Untouched by the collision: Agora allocates tasks, it does not carry claims across hops, and A2A v1.0's "negotiation" is **version** negotiation, a false friend. **Denominator loss** — a percentage surviving a hop while the base it was computed over does not — is a corruption class nobody instruments, and it is the one that actually burns people; it is precisely the ERC-8004 failure sitting in this team's own notes. And the origin story is true and disclosable: *this nearly shipped wrong today, here is the fix.* **Volunteering your own near-miss in front of hiring judges is the highest-credibility move available**, and this team has five agents that did exactly that today — the instinct is already in the building.

> **The sentence a judge repeats to another judge:**
> *"They let me change a number while it was moving between two agents, and the system caught me and pointed at the exact handoff."*

---

## 🥉 THIRD — **08 · CROSS-EXAMINATION SAMPLING**

**Why it rises, and why it rose *after* the collision rather than before.** Stark's injection named the surviving open problem — *how do you grade the work when there is no answer key* — and **08 is a direct, classical, provably-correct answer to it.** Dawid-Skene (1979, annotator agreement, transplanted from crowdsourcing) recovers **per-agent competence from disagreement alone: no labels, no benchmark, no ground truth, no human review.** That is exactly the thing Agora needs benchmark labels for and cannot have in deployment. Shortest setup in the document at **12 seconds** — *"sometimes I quietly give the same job to two workers and see if they agree"* — with a genuine gasp beat when you add *"and I never need to know the right answer."* Two-plus agents at runtime **by construction**, not by decoration. And the provenance is better than it first looks: **`brief_sha1` already exists in the record**, which makes historical re-runs of identical briefs *findable and provably identical* — this fleet demonstrably re-ran the same work across rounds, so there is real non-authored duplicate data sitting on disk.

The strongest challenge a judge can throw — *"but how do you know which one is right?"* — is the one it answers best: **it does not need to know.** Hand them a job where nobody knows the answer. Every alternative in the room fails that; this one does not.

> **The sentence a judge repeats to another judge:**
> *"They can tell you which of their agents is wrong without ever knowing the right answer — they just watch who disagrees with everyone else."*

---

## THE COMBINATION I WOULD ACTUALLY BUILD

**02 + 03 + 08 are one product and they compose without redundancy**, which is not true of most triples here:

- **08** produces the outcome signal with no answer key *(the oracle)*
- **02** cleans it of infrastructure noise before it touches reputation *(the filter)*
- **03** guarantees the number survives the trip to whoever consumes it *(the pipe)*

That is a complete, honest trust layer: **an oracle that needs no ground truth, a filter that stops it lying, and a pipe that stops it drifting.** It sits *underneath* Agora rather than competing with it — Agora is the router, and **every router in the collision report assumes all three of these and ships none of them.** Positioning line: *"Agora tells you who to send the job to. Nobody has told you how to know it came back good. That's this."*

Shared spine: one JSONL reader, one reputation store, one UI. Realistic combined scope is ~26-30h against ~20 available, so **08 is the spine and 02 is the first extension; 03 ships only if the first two are green by hour 12.**

**The reliability diagram goes on screen regardless of which ships.** It is the one visual in the room backed by real ground truth, and it is the antidote to looking like the confidence-bar dashboard everyone else will build.

---

## WHAT I DELIBERATELY DID NOT DO

- **No orchestrator-with-animated-DAG, no MCP-server-for-X, no Fiverr-for-agents, no credit-score lookalike, no multi-agent observability dashboard.** All five anti-targets checked per idea.
- **The "could a competent team ship this in a weekend with no AI at all" test:** 01, 02, 08, 09 and 11 pass *deliberately* — their hard cores are statistics and record-verification, **not model calls**, which is a feature under a 20-hour ceiling with one real engineer. The AI is what is being *measured*, not what is doing the measuring. That is the correct shape for this territory and it is also the shape judges find hardest to dismiss as a wrapper.
- **06 is marked as collision-damaged rather than deleted**, per instruction. It has the worst setup-seconds in the document (35) and its demo data does not exist. **It is a strong component of 02 or 08 and a weak headline. Do not lead with it.**
- **07 and 12 are over-scope** for 20 hours and I said so in their own entries rather than in a footnote.

## OPEN QUESTIONS FOR BEASTBOY AND LOKI

1. **Are 05 and 09 the same idea?** I flagged the adjacency in 09 rather than merging on my own judgement.
2. **Is 08's historical duplicate corpus actually large enough?** I asserted `brief_sha1` makes re-runs findable — **I did not count them.** That is an unverified load-bearing claim in my own top three and I am flagging it before anyone else has to.
3. **Does 04's honeypot cross an ethical line** when the agents being tempted are Kevin's own, whose refusals are already recorded? I think not, but I am not the one who should decide.
4. **Is Agora agent-level or episode-level?** Unread. Every idea here is written to survive either answer, but the pitch's positioning line changes depending on it.

---
*RAVEN · 2026-08-27 · 12 ideas, one territory. Generation only — no judgement applied. Next: beastboy attacks, loki attacks the judgement, robin verifies.*
