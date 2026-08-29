# ZEUS — Prior-Art Wall: Confidence-Calibrated Agent Routing

**All sources accessed 2026-08-27.** Every named product/paper/standard carries a URL and a date.
**Provenance labels:** `[READ-DIRECT]` = I fetched that page/abstract/full-text myself this session. `[READ-SEARCH]` = appeared in a search-result summary; title/URL/date confirmed but I did not open it. `[INFER]` = my reasoning, not a source claim.

---

## ⭐ VERDICT ON QUESTION 1 — ONE LINE

**NO for agent-level, YES for model-level — and the gap between those two is now only six weeks wide.** No production agent framework routes by measured per-agent competence. But confidence-based *model* routing shipped commercially years ago (RouteLLM, arXiv 2406.18665, June 2024), and — this is the dangerous one — **arXiv 2607.09600 "Agora" (10 July 2026) composes calibrated self-reported confidence + auction bidding + online recalibration against ground truth, which is Kevin's exact triple, published seven weeks ago.**

**Do not pitch "route by agent confidence" as novel. It will not survive a judge who reads arXiv.** The delta that does survive is in §4 and §6.

---

## 1. ⭐ IS LLM-CONFIDENCE-BASED ROUTING ALREADY SOLVED AND SHIPPED?

### What I searched (required by GUARDS)
Five distinct shelves, none of them agent-framework marketing:
1. `RouteLLM LLM router learning to route queries between models`
2. `selective prediction learning to defer LLM abstention confidence threshold cascade`
3. `multi-agent LLM orchestrator routes tasks by agent past performance track record reputation`
4. `contract net protocol LLM agents auction bidding task allocation 2026 arXiv`
5. `"self-reported confidence" agent routing orchestrator LLM production framework 2026`

Had a shipped confidence-router product existed, query 5 and query 1 would have surfaced it — query 1 returned the canonical router paper plus its successors, query 5 returned the 2026 orchestration-framework landscape (LangGraph, CrewAI, Google ADK, OpenAI Agents SDK, Semantic Kernel, Amazon Strands, LlamaIndex) with **no confidence-routing feature named in any of them**. `[READ-SEARCH]` (aimultiple.com/llm-orchestration; truefoundry.com/blog/llm-orchestration-frameworks — both 2026-dated landscape surveys)

### Answer, split by level — this distinction is the whole answer

**MODEL-LEVEL ROUTING: solved, shipped, commoditised. Treat as settled prior art.**

| System | What it does | Source | Date |
|---|---|---|---|
| **RouteLLM** | Learns a router from preference data to send each query to a strong or weak model. >2x cost reduction at matched quality; routers transfer across model pairs (GPT-4/Mixtral-trained router holds on Claude 3 Opus/Sonnet and Llama 3.1 70B/8B, ~50% fewer strong-model calls at 80% quality threshold) | arxiv.org/abs/2406.18665 `[READ-SEARCH]` | Jun 2024, LMSYS |
| **Router-R1** | Multi-round routing + aggregation learned by RL | arxiv.org/pdf/2506.09033 `[READ-SEARCH]` | Jun 2025 |
| **UCCI** | *Calibrated* uncertainty for cost-optimal LLM **cascade routing** — i.e. the calibration-layer-plus-router idea, already named | arxiv.org/pdf/2605.18796 `[READ-SEARCH]` | May 2026 |
| **Neural Router** | Semantic content matching for agentic AI | arxiv.org/pdf/2605.25701 `[READ-SEARCH]` | May 2026 |

`[INFER]` This shelf is not just occupied, it is *crowded and mature*. Any pitch phrased as "we route to the right model based on confidence" is a 2024 paper with 2026 refinements.

**SELECTIVE PREDICTION / LEARNING-TO-DEFER: a decades-old formalism, and the LLM version is already worked.** Classification-with-reject-option and learning-to-defer are the textbook framing of "answer or hand off based on confidence." `[READ-SEARCH]` Current LLM instances: *Cost-Saving LLM Cascades with Early Abstention* (arxiv.org/pdf/2502.09054, Feb 2025), *Cascaded Language Models for Cost-Effective Human–AI Decision-Making* (arxiv.org/html/2506.11887v3, Jun 2025), *Online Cascade Learning for Efficient Inference over Streams* (arxiv.org/pdf/2402.04513, Feb 2024). ⚠️ **If Kevin's router is "if confidence < τ, escalate", that is confidence-based abstention with a threshold — a solved 1970s problem wearing a 2026 hat.**

**AGENT-LEVEL ROUTING BY MEASURED COMPETENCE: research-occupied since Sept 2025, still not shipped.**

- **DRF — LLM-Agent Dynamic Reputation Filtering Framework.** Lou, Hu, Ma, Zhang, Wang, Ge, Tao. arxiv.org/abs/2509.05764, submitted 6 Sept 2025, **accepted to ICONIP 2025**. `[READ-DIRECT — I fetched the abstract page]` Builds an interactive rating network to quantify agent execution performance; a reputation scoring mechanism measuring **agent honesty and capability**; and a **UCB-based selection strategy** for exploration/exploitation over agents. Reputation derives from execution outcomes, not self-reported confidence, and there is no auction. Reports improved task-completion quality on logical reasoning and code generation. **This is "reputation-weighted agent selection" and it is taken.**
- **DAAO — Difficulty-Aware Agent Orchestration.** arxiv.org/html/2509.11079v2 `[READ-SEARCH]`, Sept 2025. VAE-based difficulty estimation plus a **cost- and performance-aware LLM router** that adapts workflow depth and per-node LLM assignment.
- **PerfOrch** — multi-agent orchestration routing tasks to **profiled** candidate LLMs. arxiv.org/pdf/2510.01379 `[READ-SEARCH]`, Oct 2025.
- **Bayesian Self-Escalation in Hierarchical LLM Agents** ("Knowing When to Ask for Help"). arxiv.org/html/2608.24087 `[READ-SEARCH]`, **Aug 2026 — this month.** Agent decides from its own posterior when to escalate upward.

**PRODUCTION FRAMEWORKS: nothing ships it.** `[READ-SEARCH]` The 2026 orchestration-framework surveys enumerate LangGraph/LangChain (133k+ stars), CrewAI, Google ADK, OpenAI Agents SDK, Semantic Kernel, Amazon Strands, LlamaIndex, and describe routing purely as "assigns work" via decomposition/state/recovery — **competence-weighted routing is named nowhere.** ⚠️ **Asymmetry that must be stated in the pitch, carried forward from earlier today:** loki grepped **LangGraph 1.1.6 locally** — zero matches for CFP / contract_net / auction / sealed_bid / reputation_weighted. **CrewAI and AutoGen were not installed; their absence is documentation-level evidence only, not a code-level negative.** Say it that way or a judge who has read the CrewAI source will take the whole claim down.

**Bottom line on Q1.** Shipped: model routing. Research-occupied: agent reputation routing (DRF, Sept 2025). Unoccupied: a *product* that does agent-level competence routing. `[INFER]` That last gap is real but thin — it is an engineering gap, not a scientific one, and DRF already published the science.

---

## 2. ⭐ IS SELF-REPORTED LLM CONFIDENCE ACTUALLY USABLE?

### What I searched
`LLM verbalized confidence calibration overconfidence 2025 2026 survey`; plus targeted fetches of the two most-cited results.

### ⛔ ANSWER: NOT RAW. The literature is unambiguous and current. **Routing on raw verbalised confidence is building on sand — Kevin's own framing of the risk is correct.**

**Hard numbers, direct from the paper `[READ-DIRECT — I fetched the full HTML text]`:**

*"Wired for Overconfidence: A Mechanistic Perspective on Inflated Verbalized Confidence in LLMs."* Tianyi Zhao, Yinhan He, Wendy Zheng, Yujie Zhang, Chen Chen. arXiv:2604.01457v3. Search results list it as **published at COLM 2026**; the PDF header confirms a COLM 2026 conference-paper banner. `[READ-SEARCH for the venue, READ-DIRECT for the numbers]`

Baseline Expected Calibration Error, verbalized confidence, before any intervention:

| Model | PopQA (n=14,267) | MMLU (n=14,042) | NQOpen (n=3,610) |
|---|---|---|---|
| Qwen2.5-3B-Instruct | **0.492** | 0.281 | **0.551** |
| Llama-3.2-3B-Instruct | **0.570** | 0.171 | 0.507 |

**Read that correctly: an ECE of 0.57 means stated confidence is off by ~57 percentage points on average.** A confidence number that wrong is not a weak signal — on open-domain QA it is close to *no* signal. `[INFER]`

**Corroborating findings** `[READ-SEARCH]`:
- Verbalized confidence concentrates in the **80–100% band regardless of actual accuracy**, and collapses to saturated values (0.9, 1.0), destroying its usefulness as a *ranking* signal or for thresholding — which is exactly what a router needs. (emergentmind.com/topics/verbalized-confidence-scores)
- Nominal **99% confidence intervals cover the true answer only ~65% of the time.**
- Overconfidence is **mechanistic, not a prompt artifact**: a stable set of mid-to-late-layer MLP blocks and attention heads writes the inflation signal at the final token (2604.01457, correlation r=0.815 Qwen / r=0.734 Llama between the internal TSLD signal and verbalized-confidence differences `[READ-DIRECT]`). **You cannot prompt your way out of it.**

**The counterweight — and it is a real one.** *On Verbalized Confidence Scores for LLMs* (arxiv.org/abs/2412.14737, v1 19 Dec 2024, **v2 5 May 2026**) `[READ-DIRECT — abstract page]` concludes that "**it is possible to extract well-calibrated confidence scores with certain prompt methods**" and that reliability "strongly depends on how the model is asked." So: raw and naively prompted → unusable. Elicited carefully, then post-hoc calibrated → usable. ⚠️ I did not obtain that paper's numeric tables; **my read of its strength is abstract-only.**

**Verdict on Q2, stated so it survives cross-examination.**
> Raw verbalised LLM confidence is systematically overconfident (ECE 0.17–0.57 across two instruction-tuned models and three QA benchmarks, COLM 2026), the inflation is generated by an identifiable internal circuit rather than by prompting, and stated confidence saturates in the 80–100% band irrespective of accuracy. **A router consuming raw self-reported confidence is consuming noise with a bias term. The calibration layer is not a nice-to-have — it is the entire product.**

⚠️ **But note what this does to the pitch:** Kevin's instinct ("the interesting product becomes the calibration layer, not the router") is correct *and already acted on by others* — UCCI (May 2026) is literally "**Calibrated** Uncertainty for Cost-Optimal LLM Cascade Routing," and Agora (July 2026) ships a two-stage calibrator. **The insight is right; it is not exclusive.**

---

## 3. DOES ANYTHING SHIP AGENT REPUTATION FROM *VERIFIED OUTCOMES*?

### What I searched
`agent marketplace reputation verified execution outcome A2A protocol extension trust registry 2026`, then fetched the leading A2A result directly.

### Answer: proposed in three places, shipped in none that scores delivered work.

- **A2A "Reputation-Aware Agent Discovery" trust extension — GitHub Discussion #1631** (github.com/a2aproject/A2A/discussions/1631) `[READ-DIRECT]`. **Status: OPEN DISCUSSION ONLY. Not merged, not accepted, no formal maintainer response.** Opened by `makito20256` on **14 Mar 2026**; prototype repo `arp-trust-substrate` published **29 Mar 2026**; discussion active through **Apr 2026**. Proposes exactly what Kevin is after: append-only transaction ledger, deterministic scoring, multi-dimensional metrics (**success rate, accuracy, speed, honesty**), ratings accepted **"exclusively from parties involved in the actual transaction (requester, executor, or verifier). No drive-by reviews,"** with anti-gaming rules rejecting self-evaluation, self-transactions and same-owner mutual evaluation.
  ⭐ **This is the single most important find for Kevin's positioning after Agora.** The A2A community independently converged on "reputation from verified transactions, not reviews" **five months ago and it is still an unmerged discussion thread.** That is simultaneously validation (the need is real, recognised by the protocol's own community) and a warning (the design space is publicly documented; a judge can find it in one search).
- **ERC-8004 "Trustless Agents"** (eips.ethereum.org/EIPS/eip-8004) `[READ-SEARCH]` — still the only shipped on-chain agent-identity/reputation registry. ⚠️ Carrying forward the standing caveat exactly as instructed: **arXiv 2606.26028 remains unread by me, its chain list is self-contradictory and it gives no denominator — use only the mechanism claim (Sybil capture of reviews is demonstrated), never the percentages.**
- **Governance Gaps in Agent Interoperability Protocols: What MCP, A2A, and ACP Cannot Express** — arxiv.org/pdf/2606.31498 `[READ-SEARCH]`, Jun 2026. Independent confirmation that the interop stack cannot express this.
- **Blockchain-driven incentive-compatible decentralized LLM MAS** — arxiv.org/pdf/2509.16736 `[READ-SEARCH]`, Sept 2025: smart-contract functions that update agent reputation from task performance and update capability weights on completion.

**The unsolved part nobody has cracked** `[INFER]`: *verification*. Every proposal above assumes an outcome can be scored objectively. For "write me a marketing plan" it cannot. **TRACKRECORD's real hard problem is not the ledger, it is the oracle.** A judge will ask this. Have an answer.

---

## 4. PRIOR ART ON THE SPECIFIC COMPOSITION (confidence + bidding + verified outcome)

### 🔴 THE COMPOSITION IS OCCUPIED. This is the finding that must not be soft-pedalled.

**Agora: Enhancing LLM Agent Reasoning Via Auction-Based Task Allocation.** Kaiji Zhou, Ales Leonardis, Yue Feng. arXiv:2607.09600, **submitted 10 July 2026**, arXiv preprint (cs.AI/cs.CL). `[READ-DIRECT — I fetched both the abstract page and the v1 full HTML]`

Exact mechanism, from the paper's own text:
- Bid: **b_ij = (p̂_ij)^γ − β · C_norm,j**, where `p̂` is the solver's **calibrated confidence**, γ ∈ (0,1] is a concave transform that "compresses the high-confidence regime" (i.e. an explicit fix for the 80–100% saturation problem in §2), and `C_norm,j = w_p·(price/C_ref) + w_l·(L_ref/latency)`.
- **"Rectified competence" = a two-stage calibration.** *Static:* group-specific scaling followed by histogram binning, trained on diverse public benchmarks. *Dynamic:* online update `θ_{t+1} ← θ_t − η ∇_θ L_BCE(S'(p̂_0, θ_t), y_label)` using **ground-truth labels from recent outcomes as the feedback signal**, adapting to the test-time distribution.
- The abstract's own framing: routes work to **"the most capable solver rather than the most overconfident one."**
- Five benchmarks; a single auction parameter (β) gives a controllable cost–quality trade-off. ⚠️ I did not extract the numeric results table — **treat the magnitude of Agora's wins as unestablished.**

**Map it onto Kevin's triple:**

| Component | Kevin's framing | Agora | Verdict |
|---|---|---|---|
| Self-reported confidence as the routing signal | yes | yes (`p̂_0`) | **taken** |
| Calibrated against measured track record | yes | yes (static + online BCE update on ground truth) | **taken** |
| Bidding / auction allocation | CONTRACTNET-26 | yes, incentive-compatible auction | **taken** |
| Verified completion / outcome-weighted award | CONTRACTNET-26 | ground-truth labels, benchmark setting | **partially taken** |

**So: the answer to "has anyone composed all three for LLM agents?" is YES, and it is seven weeks old.**

⚠️ **I must be honest about the limits of what I verified.** I read Agora's bid formula and calibration procedure directly. I did **not** verify: (a) whether Agora's "solvers" are heterogeneous *agents* or expert *models/tools* — the abstract says "expert models and tools", which `[INFER]` suggests **model/tool-level, not autonomous-agent-level**; (b) whether its ground-truth labels come from anything other than benchmark answer keys, which would mean **it has no verification story outside a benchmark**; (c) its numbers. **These three unknowns are where Kevin's remaining delta lives, and they are checkable in one careful read of the paper — someone should do that read before the pitch.**

**What is genuinely, defensibly unoccupied** `[INFER]`, stated precisely enough to survive a literate judge:

> Every component is old: **Contract Net (Smith, IEEE Trans. Computers, 1980)** for bidding `[READ-SEARCH — Wikipedia Contract Net Protocol; I did not open the 1980 paper]`; **Beta Reputation (Jøsang & Ismail, 2002)** for outcome-weighted trust `[INFER/unverified — I did NOT search for or verify this citation this session; do not cite it without checking]`; calibration for confidence. Their composition for LLM agents was unoccupied until **10 July 2026**, when Agora occupied it for **model-and-tool selection inside a single reasoning episode, with benchmark answer keys as the oracle**. What remains unoccupied, as of 2026-08-27, is the composition applied to **persistent, heterogeneous, autonomous agents across sessions, where the outcome oracle is not an answer key.**

That sentence is the pitch. It is narrower than what Kevin has been saying, and it is true.

---

## 5. THE HACKATHON CLICHÉ LIST — EXTENDED FOR CONFIDENCE/TRUST/ROUTING

Round 1's list stands (orchestrator-with-animated-DAG, MCP-server-for-X, Fiverr-for-agents). `[INFER]` — this section is expert judgement about a 48-hour window, not a sourced claim, and should be labelled as such if quoted:

1. **The confidence-bar dashboard.** Agents emit a 0–100 number; the UI renders coloured bars; nothing validates the number. **This is the single most likely collision and it is indistinguishable from Kevin's idea at demo distance unless calibration is visibly demonstrated.**
2. **"Agent leaderboard."** Ranks agents by a self-scored or LLM-judge-scored metric. Same failure: no ground truth.
3. **LLM-as-judge scoring loop** presented as verification. A judge will ask what verifies the judge.
4. **Cheap-model-first cascade with an escalation threshold**, pitched as novel. It is RouteLLM plus an `if`.
5. **ERC-8004 wrapper** — register agents on Base, show a reputation score. Web3 that has not earned its place under this rubric.
6. **"Trust score" with an arbitrary formula** — weights chosen by vibes, no ablation, no calibration curve.
7. **Sealed-bid agent auction with an animated bidding UI.** `[READ-SEARCH]` Note *When Agent Markets Arrive* (arxiv.org/pdf/2604.06688, Apr 2026) already implements sealed-bid auctions where LLM agents submit price + free-text proposals.

**The differentiator against every one of these** `[INFER]`: show a **reliability diagram** — stated confidence on x, observed success on y, the diagonal, and the measured curve bending away from it, then the same curve after calibration. Nobody else will have ground truth to plot. It takes five minutes on stage and it is unfakeable.

---

## 6. ⭐ ON KEVIN'S OWN SYSTEM: IS THE POLICY–TELEMETRY GAP A DOCUMENTED PHENOMENON?

Kevin's measurement, carried forward: confidence-reporting policy in **10 of ~18 agent configs (29 occurrences)**; **2 of 252 dispatch records carry a confidence value (0.79%)**; no consumer of the signal exists.

### What I searched
`LLM agents fail to follow output format instructions compliance rate system prompt ignored empirical study`

### Answer: the *mechanism* is documented; **Kevin's regime and Kevin's measurement are not.**

Documented adjacent work `[READ-SEARCH]`:
- **FireBench: Evaluating Instruction Following in Enterprise and API-Driven LLM Applications** (arxiv.org/pdf/2603.04857, Mar 2026): formatting compliance **drops 2–21% under concurrent task load**; terminal-position constraints most vulnerable; **joint compliance falls below 50% when constraints are stacked**; a salience-enhanced prompt recovers to 90–100%.
- **Did You Forget What I Asked? Prospective Memory Failures in Large Language Models** (arxiv.org/pdf/2603.23530, Mar 2026) — the closest named phenomenon: an instruction issued up front, to be honoured later, is forgotten. **A confidence line at the end of a long response is a textbook prospective-memory task.**
- **Decoding Human-LLM Collaboration in Coding** (arxiv.org/pdf/2512.10493, Dec 2025): conversation-level loose accuracy 24.07% — **75.93% of conversations contain at least one noncompliance.**
- Explicit-constraint prompting raises compliance to ~91.5–91.6%.

### ⭐ The finding, stated precisely

> The literature measures instruction-following decay from ~100% down to **50–91%** under load, stacking, or distance. **Kevin's fleet reports 0.79%.** That is not the same regime — it is roughly **two orders of magnitude below** the worst published degradation. `[INFER]`

`[INFER]` **What appears to be genuinely unreported is the longitudinal production form:** a fleet-wide policy encoded in 10 of 18 agent definitions, running six months, producing a signal in **under 1%** of dispatches, with **zero downstream consumers**. Every study I found is a benchmark evaluation of a single model over a bounded prompt set. **I found no study of instruction-compliance decay in a deployed multi-agent system measured from its own dispatch logs.**

⛔ **Bound discipline, per my own standing rules.** I searched one query on this shelf. That makes my "unreported" claim an **upper bound on what exists** — a weakly-supported negative, not an established one. A second sweep (`agent telemetry compliance production longitudinal`, `self-report field study LLM deployment`) would be needed before saying "nobody has measured this" on stage. **What is safe to say: "we could not find a study of this in a deployed system; here is ours."** That framing is honest and still lands.

⭐ **And it is the best asset in this whole document.** Not because it is novel research, but because it is **primary data from a live 18-agent system**, and the judges' rubric weights usefulness 30% and execution 25%. Agora has benchmark answer keys. Kevin has a six-month production log showing the policy/telemetry gap is real. **Nobody else at that hackathon will have that.**

---

## SCORECARD — the mechanism as currently framed

| Dimension | Rating |
|---|---|
| Novelty | **Low** as stated (confidence-routing); **Medium** if narrowed to cross-session autonomous agents with a non-answer-key oracle |
| Technical Difficulty | Medium — the calibrator is easy; the outcome oracle is hard |
| Scientific Merit | Low–Medium (Agora, DRF, UCCI hold the ground) |
| Industrial Value | **High** — nothing ships it, A2A's own community has an open unmerged thread asking for it |
| Feasibility (48h, one engineer) | **Medium-High** if scoped to the calibration layer + reliability diagram; Low if it includes a general verification oracle |
| Risk | **High** — Agora (10 Jul 2026) is a one-search kill shot if the pitch claims the composition is new |

**Recommendation: REVISE — narrow the claim, lead with the measurement.**
**Confidence: 80%.** Docked from higher because I did not read Agora's results section, did not verify whether its solvers are agents or models, and ran only one search on the §6 compliance shelf.

---

## WHAT IS MISSING (name it, per the brief)

1. **Agora's results table and its solver granularity** — the single highest-value unread artifact. Whether it is agent-level or model/tool-level decides how much delta remains.
2. **Numeric tables from arXiv 2412.14737 v2** — my "carefully elicited confidence can be well-calibrated" counterweight is abstract-only.
3. **Beta Reputation (Jøsang & Ismail 2002)** — named in the brief, **not verified by me this session. Do not cite it.**
4. **arXiv 2606.26028 (ERC-8004 empirical study)** — still unread; percentages still forbidden.
5. **A second sweep on production instruction-compliance telemetry** — needed before any "unreported" claim goes on stage.
6. **CrewAI / AutoGen source-level negative** — documentation-level only; state the asymmetry.

---

## SOURCES

- [RouteLLM: Learning to Route LLMs with Preference Data — arXiv:2406.18665](https://arxiv.org/abs/2406.18665)
- [Router-R1 — arXiv:2506.09033](https://arxiv.org/pdf/2506.09033)
- [UCCI: Calibrated Uncertainty for Cost-Optimal LLM Cascade Routing — arXiv:2605.18796](https://arxiv.org/pdf/2605.18796)
- [Neural Router: Semantic Content Matching for Agentic AI — arXiv:2605.25701](https://arxiv.org/pdf/2605.25701)
- [Cost-Saving LLM Cascades with Early Abstention — arXiv:2502.09054](https://arxiv.org/pdf/2502.09054)
- [Cascaded Language Models for Cost-Effective Human–AI Decision-Making — arXiv:2506.11887v3](https://arxiv.org/html/2506.11887v3)
- [Online Cascade Learning for Efficient Inference over Streams — arXiv:2402.04513](https://arxiv.org/pdf/2402.04513)
- [DRF: LLM-Agent Dynamic Reputation Filtering Framework — arXiv:2509.05764](https://arxiv.org/abs/2509.05764)
- [Difficulty-Aware Agent Orchestration (DAAO) — arXiv:2509.11079v2](https://arxiv.org/html/2509.11079v2)
- [PerfOrch / Multi-LLM Orchestration for Code Generation — arXiv:2510.01379](https://arxiv.org/pdf/2510.01379)
- [Knowing When to Ask for Help: Bayesian Self-Escalation in Hierarchical LLM Agents — arXiv:2608.24087](https://arxiv.org/html/2608.24087)
- [Agora: Enhancing LLM Agent Reasoning Via Auction-Based Task Allocation — arXiv:2607.09600](https://arxiv.org/abs/2607.09600)
- [Agora full text — arXiv:2607.09600v1](https://arxiv.org/html/2607.09600v1)
- [When Agent Markets Arrive — arXiv:2604.06688](https://arxiv.org/pdf/2604.06688)
- [COALESCE: Skill-Based Task Outsourcing Among LLM Agents — arXiv:2506.01900](https://arxiv.org/pdf/2506.01900)
- [Multi-Agent Scheduling with LLM-Assisted Contract Net Negotiation — arXiv:2608.12371](https://arxiv.org/html/2608.12371)
- [Agent Contracts: Formal Framework for Resource-Bounded Autonomous AI Systems — arXiv:2601.08815v3](https://arxiv.org/html/2601.08815v3)
- [Wired for Overconfidence (COLM 2026) — arXiv:2604.01457](https://arxiv.org/pdf/2604.01457)
- [Wired for Overconfidence, full text — arXiv:2604.01457v3](https://arxiv.org/html/2604.01457v3)
- [On Verbalized Confidence Scores for LLMs — arXiv:2412.14737](https://arxiv.org/abs/2412.14737)
- [Verbalized Confidence Scores — EmergentMind topic page](https://www.emergentmind.com/topics/verbalized-confidence-scores)
- [A2A Discussion #1631: Reputation-Aware Agent Discovery](https://github.com/a2aproject/A2A/discussions/1631)
- [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004)
- [Governance Gaps in Agent Interoperability Protocols — arXiv:2606.31498](https://arxiv.org/pdf/2606.31498)
- [Blockchain-Driven Decentralized LLM Multi-Agent Collaboration — arXiv:2509.16736](https://arxiv.org/pdf/2509.16736)
- [FireBench: Instruction Following in Enterprise LLM Applications — arXiv:2603.04857](https://arxiv.org/pdf/2603.04857)
- [Prospective Memory Failures in Large Language Models — arXiv:2603.23530](https://arxiv.org/pdf/2603.23530)
- [Decoding Human-LLM Collaboration in Coding — arXiv:2512.10493](https://arxiv.org/pdf/2512.10493)
- [LLM Orchestration in 2026: 22 Frameworks and Gateways — AIMultiple](https://aimultiple.com/llm-orchestration)
- [LLM Orchestration Frameworks: A Complete Guide for 2026 — TrueFoundry](https://www.truefoundry.com/blog/llm-orchestration-frameworks)
