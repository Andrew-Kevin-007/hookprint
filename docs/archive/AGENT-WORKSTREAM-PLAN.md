# AGENT WORKSTREAM PLAN

## Purpose

This plan covers the work the assistant and supporting execution streams can do while Claude is unavailable until the 12PM reset.

The intent is to reduce future friction and keep the project moving without forcing Claude to re-do basic setup work.

---

## 1. Working principle

The current execution window is for preparation, not final deep implementation.

Assistant-owned work should focus on:
- scaffolding the system
- locking architecture decisions
- refining specs
- preparing reusable modules
- creating clean handoff artifacts
- validating that no repo state is broken during the gap

---

## 2. Workstreams for the assistant

### Workstream A — architecture preparation
- confirm the hybrid model remains consistent with BATON
- define the explicit difference between BATON trust layer and quota-dispatch layer
- keep context-window degradation as a first-class design constraint
- capture the layer responsibilities clearly

### Workstream B — repo and worktree readiness
- verify all worktrees are in the expected state
- confirm git status is clean enough for focused work
- ensure relevant implementation directories exist for the eventual build
- prepare the repo for sprint-based implementation

### Workstream C — data model drafting
- draft raw schema for:
  - tasks
  - providers
  - agent predictions
  - execution logs
  - completion logs
  - reputation records
  - route decisions
- define the minimum fields needed for the first working version

### Workstream D — backlog refinement
- split implementation into concrete tasks
- define dependencies between tasks
- create a clean pre-implementation checklist
- document assumptions and constraints

### Workstream E — UI scaffolding preparation
- create a preliminary dashboard data model
- decide the minimal views needed for first product demonstration
- define what telemetry will be useful for the first build

### Workstream F — risk capture
- track all known risks: context-window degradation, silent failover, false reputation, provider drift, etc.
- keep a focused blocker list for Claude to review

---

## 3. Pre-implementation checklist

Before starting the deeper implementation pass, the assistant should ensure the following are ready:

- current architecture direction is written down
- BATON core is preserved as the trust foundation
- hybrid layer responsibilities are clearly separated
- provider quality model is documented
- batch-size rule is explicitly defined
- route output structure is sketched
- sign + reputation + ledger model is in place conceptually
- repo is stable and not in a broken state

---

## 4. What not to do during this window

The assistant should avoid:
- broad speculative rewrites
- changing core BATON files without a clear reason
- reworking the whole repo structure while the handoff is pending
- building production-grade code before the architecture is locked
- exploring too many optional frameworks or abstractions

The build should remain disciplined and incremental.

---

## 5. Current priority queue for the assistant

### Priority 1 — lock the architecture boundary
- BATON core = trust and provenance
- hybrid quota system = routing + batching + quality logic

### Priority 2 — define the data contract
- Task object
- Prediction object
- Route object
- Completion object
- Reputation object

### Priority 3 — define provider profile schema
- context capacity
- safe batch ceiling
- quality curve metadata
- expected latency and token burn

### Priority 4 — define route-selection heuristics
- quality target
- cost target
- latency target
- privacy target
- fallbacks and override conditions

### Priority 5 — prepare the handoff package
- make sure all artifacts are dated and preserved
- ensure Claude can resume without re-reading the whole conversation

---

## 6. Handoff output required before Claude returns

The assistant should prepare and preserve the following artifacts:

1. [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)
2. [CLAUDE-12PM-HANDOFF-PLAN.md](CLAUDE-12PM-HANDOFF-PLAN.md)
3. Current blocker list
4. Current architecture notes
5. The working route-selection definition
6. The provider profile schema draft
7. The initial task/data model draft

---

## 7. Parallel execution note

This workstream should proceed in parallel with the Claude handoff plan, but it should remain bounded and disciplined.

The assistant can do the setup, but should not replace the deeper implementation work that Claude is best suited to do after reset.

---

## 8. Completion gate

Assistant work is complete when:
- the repo is stable
- architecture direction is captured
- blockers are recorded
- the next tasks are unambiguous
- the handoff package is ready for Claude
- no critical ambiguity remains that would require re-discovery

---

## 9. Final reminder

This is a staging plan for operational continuity.

The goal is not to do the final architecture work here. The goal is to reduce rework, keep momentum alive, and make the noon handoff feel like one continuous build rather than a restart.
