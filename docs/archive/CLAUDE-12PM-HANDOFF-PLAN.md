# CLAUDE 12PM HANDOFF PLAN

## Purpose

This plan exists so the high-context, high-complexity work can be resumed when Claude is available again after the 12PM reset, without losing momentum or continuity.

The goal is to keep the build moving in parallel while preserving a clean handoff boundary.

---

## 1. Operating principle

Claude is the high-context, deep-thinking executor. The assistant and other lightweight execution streams should prepare the system, scaffold the work, and reduce unknowns before Claude returns.

This is not a reset of the project. It is a deliberate handoff.

---

## 2. Window logic

### Before 12:00 PM
Use this time for:
- architecture cleanup
- implementation scaffolding
- task decomposition
- repo preparation
- decision capture
- backlog preparation
- preparing exact prompts and acceptance criteria for Claude

### At / after 12:00 PM
Use this window for:
- deep implementation work
- complex logic rewriting
- cross-worktree integration tasks
- trust and reputation design decisions
- difficult bug fixing and final reconciliation
- validation and end-to-end build work

---

## 3. Claude work queue

### Priority A — complex delivery tasks
1. Finalize hybrid BATON + quota-routing architecture in code
2. Implement provider-profile and degradation-curve model
3. Implement safe batch planner and context-reset execution logic
4. Build agent prediction and reputation scoring loop
5. Integrate BATON signing and provenance with routing decisions

### Priority B — integration tasks
1. Connect baton, baton-registry, baton-stake, baton-swarm, baton-ui, and baton-diff
2. Wire ledger + prediction + dispatch + observation flows together
3. Validate end-to-end route selection logic
4. Add failure-handling and fallback explanation flows

### Priority C — polish / validation
1. Stabilize dashboard and routing explanation views
2. Verify edge cases around large document batches
3. Check migration of original BATON features into the new system
4. Final integration test and cleanup

---

## 4. Handoff package that must be ready before Claude returns

Before 12:00 PM, the project should have:
- unified architecture direction
- final MVP scope definition
- known constraints and assumptions written down
- clean sprint order
- design decisions captured
- tasks broken into implementable chunks
- active blockers documented with status

### Required artifacts
- [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)
- [AGENT-WORKSTREAM-PLAN.md](AGENT-WORKSTREAM-PLAN.md)
- current repo state review
- worktree scope review
- risk and blocker list

---

## 5. Claude execution rules

When Claude returns, the goal is to continue with minimal reorientation.

Rules:
- start with the already-written plan and do not re-litigate the problem statement
- continue from the current architecture direction, not from a blank slate
- implement in the sprint order, not ad hoc
- keep the core BATON trust layer untouched unless the hybrid design requires explicit changes
- treat context-window safety as non-negotiable
- log all route decisions and prediction outcomes

---

## 6. Workstream separation

### Claude-owned work
- complex architecture implementation
- difficult logic and scheduler design
- integration across worktrees
- validation and final hardening

### Assistant-owned work
- documentation and planning
- scaffolding and repo setup
- backlog refinement
- data-model drafting
- workstream preparation
- handoff prep

This way the system never stalls waiting on the same reasoning loop.

---

## 7. Restart checklist for Claude

On return, Claude should begin by checking:
1. This plan is still valid
2. The implementation plan still matches the repo state
3. The current workstream files are up to date
4. No unknown blocker has appeared while the system was idle
5. The next ordered implementation task is clear

If any of these are unclear, Claude should recover from the existing plan rather than re-discovering fundamentals from scratch.

---

## 8. Exit criteria for this handoff

The project is considered ready for the Claude restart when:
- all active tasks are classified and sequenced
- the context-window issue is explicitly recognized as a system design constraint
- the architecture path is clear and stable
- no major open question remains that blocks implementation
- all work is ready to continue without interruption

---

## 9. Final note

This is a continuity plan, not a pause plan.

The objective is simple: keep the project moving in parallel, preserve the architecture, and make the noon reset feel like a seamless continuation instead of a restart.
