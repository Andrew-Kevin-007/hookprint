# BATON HYBRID QUOTA-ROUTING IMPLEMENTATION PLAN

## Product thesis

This project is a hybrid of the original BATON trust layer and a new quota-aware, context-window-safe dispatch architecture.

The original BATON foundation remains essential:
- signed provenance and claim verification
- deterministic alignment and diffing
- registry of agents and model capabilities
- reputation and staking tied to verified outcomes
- local ledger for ground-truth state
- protection against poisoning and false claim propagation

The new layer adds:
- quality-targeted routing instead of token-only routing
- provider/model-specific context-window degradation curves
- adaptive batch sizing with fresh-context execution
- agent reputation for predicting correct batching and quality thresholds
- quota-aware dispatch that avoids the reactive failover trap

The key architectural fix is this:
- large prompt batches degrade as context grows
- therefore task routing must be based on safe chunk size, not just pool availability
- the system must reset context between chunks and measure per-batch quality

---

## 1. Goals

### Core product goals
1. Build a trusted multi-provider LLM routing layer that does not silently fail when the context window saturates.
2. Route work by quality tier, not just by token budget.
3. Predict the correct batch size and provider for each workload class.
4. Keep BATON’s original security/trust features intact.
5. Turn agent reputation into a meaningful signal for real execution quality and batching accuracy.
6. Create a product that is clearly differentiated from OmniRouter’s reactive failover model.

### Success criteria
- Tasks are routed before quota exhaustion becomes a problem.
- High-quality tasks stay above target quality thresholds.
- Large document batches are split into safe, context-aware chunks.
- Agent prediction accuracy improves over time.
- Historical execution logs are cryptographically and semantically traceable.
- The system can explain why a route was chosen.

---

## 2. Scope

### In scope
- task intake and workload classification
- ledger and telemetry foundation
- provider profile modeling
- safe batch sizing rules
- quality-tier dispatch
- multi-agent prediction and trust scoring
- verification and reputation updates
- UI dashboard for routing and quality outcomes
- audit/debug view for agent/provider decisions

### Out of scope for initial delivery
- real production billing integration
- full multi-user auth/ RBAC
- full distributed deployment infra
- advanced external marketplace economics
- external governance/policy engines beyond core safety rules

---

## 3. Architectural foundation

### A. BATON core
This remains the base platform.

Required components:
- claim canonicalization and signing
- evidence ledger
- agent registry
- task and completion event schema
- task provenance and immutable logs
- align/diff layer for comparing outputs and detecting drift
- stake/reputation model

### B. Hybrid quota-routing layer
This is the new product layer.

Required components:
- workload classifier
- quality target model
- provider profile database
- degradation-curve engine
- safe batch sizing logic
- fresh-context execution runner
- dispatcher/scheduler
- aggregator and verification engine
- reputation update loop

---

## 4. Proposed system flow

1. User submits task with quality target and constraints.
2. System classifies workload type and expected difficulty.
3. Agent set predicts route, quality target, batch size, and fallback.
4. Dispatcher evaluates agent reputation and provider profiles.
5. System computes safe batch boundaries using context-window degradation curves.
6. Each batch is executed with a fresh context window.
7. Results are aggregated, verified, and scored.
8. Predictions and outcomes update the ledger and reputation state.

---

## 5. Sprint breakdown

## Sprint 1 — Foundation and trust layer

### Objective
Lock the BATON base so every new product layer rests on a trustworthy and auditable execution model.

### Deliverables
- final ledger schema for tasks, dispatches, completions, reputations, provider state
- signed task provenance model
- agent registry data structure
- canonical claim/event format
- repo structure for shared BATON core and new routing layer

### Workstreams
#### 1. Ledger foundation
- define task events: create, route, execute, complete, fail, fallback
- define provider pool status records
- define actual token / latency / quality outcomes
- define prediction and reputation record schema

#### 2. Security and traceability
- canonical task hash generation
- signed dispatch logs
- output provenance binding
- ledger immutability rules

#### 3. Registry and model metadata
- agent identity record
- capability map
- provider metadata schema
- quality tier and task-type taxonomy

### Exit criteria
- A task can be created, routed, executed, and closed with signed historical evidence.
- A provider/action result can be audited after the fact.
- Agent metadata is discoverable and verifiable.

---

## Sprint 2 — Provider profiling and quality curve model

### Objective
Turn provider behavior into a measurable, predictive model instead of a vague assumption.

### Deliverables
- provider profile schema
- context-window degradation model
- batch-size quality curves per provider/model/task-class
- safe chunk ceiling calculators
- baseline telemetry capture for Anthropic, OpenAI, and local models

### Workstreams
#### 1. Provider profiles
- track max context size
- track task class performance by chunk size
- track quality degradation as context grows
- track latency, token burn, error rates

#### 2. Degradation modeling
- define quality score mechanism for each output chunk
- create per-provider curves for small vs medium vs large workloads
- store “safe operating zone” metadata

#### 3. Task class taxonomy
- summarization
- extraction
- reasoning
- synthesis
- multi-document comparison
- code analysis

### Exit criteria
- The system can answer: “What is the safe batch size for provider X on task Y?”
- Output quality can be tied to context size with measurable degradation.

---

## Sprint 3 — Batch planner and dispatcher

### Objective
Build the routing engine that chooses the right provider and batch shape before execution starts.

### Deliverables
- workload classifier
- target-quality planner
- batch planner
- dispatcher policy engine
- route selection output format

### Workstreams
#### 1. Task planner
- normalize user requirement into target quality, deadline, cost, privacy, and size constraints
- compute safe work partitioning

#### 2. Batch planner
- choose chunk size per provider
- compute total chunk count
- decide whether to parallelize
- decide when fresh-context resets are required

#### 3. Route selection
- gather agent predictions
- weight by reputation
- consider provider fit and quality curve
- select preferred route and backup route

### Exit criteria
- Given a task and target quality, the system can output a route plan including chunk boundaries and fallback logic.
- The plan should explicitly avoid oversized context windows.

---

## Sprint 4 — Agent prediction engine and reputation loop

### Objective
Turn prediction accuracy into real trust.

### Deliverables
- prediction schema for quality tier, batch size, provider, and confidence
- scoring model for prediction quality
- reputation update engine
- historical performance analytics
- agent leaderboard and trust tiers

### Workstreams
#### 1. Prediction model
- per-agent prediction of task fit
- quality estimate per provider
- degradation estimate per provider + task type
- recommended chunk size with confidence score

#### 2. Reputation logic
- combine historical and recent accuracy
- reward high-quality batch-size predictions
- penalize silent context-window mismatches
- tie reputation to actual task outcomes

#### 3. Verification logic
- compare predicted quality and batch size to actual results
- compute prediction error against ledger
- update provider and agent profiles

### Exit criteria
- A predicted route is auditable against actual results.
- Agents gain or lose trust based on verified execution outcomes.

---

## Sprint 5 — Execution runner and context reset safety

### Objective
Make the system robust to the exact failure mode discovered in the context-window problem.

### Deliverables
- fresh-context execution runner
- chunk-safe batching executor
- output aggregation pipeline
- quality verification after each batch
- fallback trigger conditions

### Workstreams
#### 1. Execution safety
- enforce maximum batch size rules
- automatically split overlarge workloads
- clear context between batches
- record chunk-level evidence

#### 2. Aggregation
- merge chunk outputs
- de-duplicate overlapping results
- compare outputs for contradictions or drift
- integrate BATON align/diff logic

#### 3. Fallback path
- if provider violates expected curve, retry on alternative route
- log reason and evidence for the shift
- avoid silent failure

### Exit criteria
- The system consistently avoids giant context batches that degrade quality.
- Chunked tasks retain quality and can be traced transparently.

---

## Sprint 6 — Product polish, observability, and dashboard

### Objective
Turn the core system into a usable product surface with explainability.

### Deliverables
- route dashboard
- provider health view
- quality vs batch-size charts
- agent reputation dashboard
- task audit timeline
- override controls for human intervention

### Workstreams
#### 1. Frontend dashboard
- queue of active tasks
- provider performance summary
- prediction confidence by agent
- safe batch recommendations
- route explanations

#### 2. Debug / audit view
- route logs
- prediction history
- output provenance
- quality deltas
- fallback events

#### 3. Control surface
- human approval override for high-risk routes
- emergency fallback toggles
- quality threshold tuning for production teams

### Exit criteria
- A user can understand why work was routed a certain way.
- A team can inspect the quality and trust history of each route.
- Human operators can intervene without losing traceability.

---

## Sprint 7 — Hardening and production readiness

### Objective
Prepare the hybrid system for real use in a controlled environment.

### Deliverables
- resilience and retry logic
- failure-mode testing
- performance benchmarks
- provider quality regression checks
- security pass

### Workstreams
#### 1. Reliability
- retries for transient provider errors
- graceful degradation when provider curves break
- idempotent task handling

#### 2. Quality assurance
- verify no silent quality degradation
- test batch-splitting edge cases
- validate historical reputation recalibration

#### 3. Security and compliance
- verify signed task records
- check agent trust boundaries
- validate provider isolation and data rules

### Exit criteria
- The system behaves predictably under load and under poor-quality route assumptions.
- It is resilient enough to be treated as a serious product layer, not a prototype.

---

## 7. Implementation order by repo worktree

### baton
Primary work:
- shared ledger model
- signed events
- claim canonicalization
- align/diff logic
- verification primitives

### baton-registry
Primary work:
- agent registry
- provider registry
- capability map
- trust metadata

### baton-stake
Primary work:
- reputation scoring
- stake-based trust models
- historical accuracy weighting

### baton-swarm
Primary work:
- model execution harness
- provider task execution runner
- chunked dispatch integration
- quality scoring for actual runs

### baton-ui
Primary work:
- route decision dashboard
- provider health UI
- quality and batch-size charts
- task audit and verification UI

### baton-diff
Primary work:
- compare outputs across batches and providers
- detect contradictions and drift in combined results
- quality consistency checks across aggregated output

---

## 8. Key design principles

1. Quality first, quotas second.
2. Context size is a major first-class variable.
3. Agent predictions must be verifiable.
4. No silent fallback without explanation.
5. Provider behavior is learned, not assumed.
6. Trust must be auditable and tied to evidence.
7. Large tasks are not sent as one giant input when the model degrades under context pressure.
8. The system should be more intelligent than OmniRouter, not just more reactive.

---

## 9. Product positioning

This product is not just a quota router. It is a trust-aware orchestration layer for multi-model work.

Its strongest differentiator is:
- quality-aware decomposition
- context-window-safe batching
- agent learning over real execution outcomes
- cryptographic provenance and reputation-driven routing

That gives it a more durable and more “fun” product identity than simple reactive model failover.

---

## 10. Immediate next action

The next step after this plan is to begin implementation in the following order:
1. ledger schema and event definitions
2. provider profile and quality-curve model
3. batch planner and route policy engine
4. signed prediction + reputation loop
5. UI dashboard + audit screens

This gives us a clean build sequence with minimal architectural risk.

---

## 11. Noon-reset parallel execution plan

### Operating rule
The original BATON problem is not reopened. The build proceeds from the already-accepted architecture:
- BATON remains the trust and provenance foundation.
- the quota-routing layer is additive and context-window aware.
- routing decisions must be based on safe chunk size, provider fit, and fresh-context execution.
- no workstream should re-argue the thesis; it should execute against the frozen constraints.

### Execution windows
- Current assistant execution: now until 12:00 PM.
- Claude-return execution: immediately after Claude resets at 12:00 PM, using the same frozen scope and handoff artifacts.

### Priority order
P0 = must finish before any downstream work.
P1 = required for first usable routing loop.
P2 = product polish and observability.

### Stream A — Current assistant execution (now to 12:00 PM)

#### A1. Freeze the architecture contract and handoff state (P0)
- confirm the BATON trust layer remains unchanged except for explicit integration points
- lock the success criteria, scope boundaries, and routing decisions
- write a single state snapshot for the Claude reset
- produce the working decision log: what is decided, what is deferred, and what is blocked

Deliverables:
- architecture contract summary
- verified scope list
- explicit “do not re-litigate” note
- current branch/task status snapshot

Dependencies:
- none; this is the handoff foundation

#### A2. Define the ledger and provider schema (P0)
- finalize task event schema for create → route → execute → complete/fail/fallback
- define provider profile fields: max context, task class fit, safe chunk ceiling, quality degradation curve, latency, cost, and failure profile
- define prediction and reputation record schema
- ensure all records remain BATON-signable and auditable

Deliverables:
- ledger schema document
- provider profile interfaces
- prediction/reputation types

Dependencies:
- A1 must be complete before schema changes are treated as final

#### A3. Build the routing primitives (P1)
- create workload classifier
- define quality target model and route scoring inputs
- add safe-batch calculations based on context-window degradation curves
- define chunk-splitting policy and fresh-context reset conditions

Deliverables:
- workload taxonomy
- safe batch calculator
- route planning interfaces

Dependencies:
- A2 must be in place before routing logic is implemented

#### A4. Prepare the execution harness and verification scaffold (P1)
- create runner skeleton for batched execution
- define verification gate after each chunk
- define task aggregation and contradiction diff checks using BATON align/diff primitives
- prepare fallback trigger conditions with reasons and evidence capture

Deliverables:
- execution harness skeleton
- verification contract
- fallback policy spec

Dependencies:
- A2 and A3 completed for meaningful runner contracts

#### A5. Frontend contract and dashboard skeleton (P2)
- define route decision payload and UI contract
- prepare route audit panel schema
- define quality and chunk-size visualization stubs

Deliverables:
- dashboard payload schema
- audit event contract

Dependencies:
- A3 and A4 for real route data semantics

---

### Stream B — Claude-return execution (12:00 PM onward)

#### B1. Implement ledger + task provenance (P0)
- write the BATON-backed event model in the core packages
- implement canonical task hash and signed provenance binding
- add immutable ledger checks and event replay support

Deliverables:
- signed task history
- ledger replayability
- immutable event validation

Dependencies:
- A1 and A2 complete before implementation begins

#### B2. Implement provider profiles and degradation modeling (P0/P1)
- wire provider metadata into registry
- encode safe operating-zone calculations
- add per-provider quality curves for small, medium, and large tasks
- validate task-type mapping to provider strengths

Deliverables:
- provider profile model
- degradation curve engine
- safe operating zone outputs

Dependencies:
- A2 and A3 complete

#### B3. Build batch planner and dispatcher policy (P1)
- implement route-selection logic that prefers safe chunking over quota-only dispatch
- integrate reputation weights with provider fit
- produce preferred route + fallback route outputs

Deliverables:
- dispatcher policy engine
- route plan output contract
- fallback plan logic

Dependencies:
- A3 and B2 complete before policy logic is trusted

#### B4. Implement prediction + reputation loop (P1)
- score prediction quality against actual task outcomes
- update agent/provider reputation based on verified results
- ensure silent context-window failures are penalized

Deliverables:
- prediction scoring model
- reputation update flow
- historical route-quality analysis

Dependencies:
- B1 and B3 completed for real evidence to compare against predictions

#### B5. Execute runner and aggregation validation (P1/P2)
- implement chunk-safe execution runner with fresh-context resets
- merge outputs and use BATON align/diff to detect drift or contradictions
- test fallback triggers and route correction paths

Deliverables:
- chunk-safe runner
- aggregator + verification flow
- fallback execution evidence

Dependencies:
- B2 and B3 before runner can be meaningful

#### B6. UI dashboard and audit pass (P2)
- build the route explanation surface
- add provider health and quality-vs-batch graphs
- add audit timeline and manual override controls

Deliverables:
- dashboard screens
- route explainability view
- audit trail visible to operators

Dependencies:
- B3, B4, and B5 produce the underlying signals

---

### Dependency map

Critical path:
A1 → A2 → A3 → A4 → B1/B2 → B3 → B4 → B5 → B6

Parallelizable work:
- A2 and A3 can partially overlap once the contract is frozen.
- A4 can start once A2 and A3 provide the interfaces.
- B1 and B2 are parallel once A2/A3 are complete.
- B3 and B4 are parallel after B2 and B1 respectively.
- B5 and B6 should not start before the route-output contract exists.

### Handoff structure for the 12:00 PM reset

#### Handoff package
1. Architecture contract
   - BATON trust layer frozen
   - quota-routing layer additive
   - context-window-safe batching rule enforced

2. Scope status ledger
   - completed
   - in progress
   - blocked
   - deferred with trigger

3. Dependency snapshot
   - what has to be true before the next workstream can proceed

4. Design constraints
   - no re-litigation of original problem
   - no silent fallbacks
   - no oversized prompt batches
   - all route decisions must be explainable

5. Execution checklist for Claude
   - start at B1
   - validate against the frozen contract
   - do not redesign the model; implement only missing components

#### Handoff template
```
HANDOFF: BATON HYBRID ROUTING BUILD
Status: frozen design / in-flight implementation / awaiting Claude return

FROZEN
- BATON trust layer remains authoritative
- context-window-safe routing is the required operating model
- no re-litigation of original problem

COMPLETED
- [list completed tasks]

IN PROGRESS
- [list current assistant tasks]

BLOCKED
- [dependencies still unmet]

NEXT REQUIRED
- [B1/B2/B3 in order]

DO NOT RE-OPEN
- original thesis debate
- quota-only routing assumptions
- giant-context batching without fresh-context reset
```

### Continuity guarantees
- no design reset occurs at 12:00 PM
- all work is traceable back to the same BATON trust layer and routing constraints
- the handoff is explicit, not conversationally inferred
- each downstream task has an owner, dependency, and acceptance test
- routing decisions continue from the same objective: safe, explainable, proven execution quality under context pressure

### Final execution principle
The build continues as a two-stream operation, not a restart:
- current assistant handles the contract, schema, and routing primitives before the reset
- Claude returns to implement the BATON-backed runtime, provider model, batch planner, and verification loop
- both streams converge on the same acceptance criteria without re-opening the original architecture debate

---
