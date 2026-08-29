# BATON PRODUCT — FULL ARCHITECTURE

**Status:** Product specification (not timeline-constrained)  
**Deadline:** None — build for quality, not speed  
**Target Users:** DevOps teams, ML platform engineers managing multi-LLM inference

---

## PRODUCT DEFINITION

**Problem:** Teams using multiple LLM APIs (Anthropic, OpenAI, local models) suffer quota exhaustion, cascading failures, and unpredictable costs. Current systems can't predict which tasks fit which quotas.

**Solution:** BATON is a quota-aware dispatcher that learns agent prediction accuracy. Agents predict resource usage; BATON verifies predictions; accurate agents get trusted; inaccurate ones get throttled.

**Outcome:** Zero failed tasks due to quota exhaustion. Clear metrics on which agents/providers to use for which workloads.

---

## CORE ARCHITECTURE (5 layers)

### Layer 1: LEDGER (Ground Truth)
**Purpose:** Single source of truth for resource usage

```
Structure:
  ledger/
    ├─ events.db (append-only)
    │   ├─ task_dispatched: {task_id, agent_id, model, predicted_tokens, timestamp}
    │   ├─ task_completed: {task_id, actual_tokens, actual_latency, status, timestamp}
    │   ├─ quota_checked: {model, available_tokens, timestamp}
    │   └─ agent_prediction_verified: {agent_id, accuracy_score, timestamp}
    │
    ├─ pools.json (current state)
    │   {
    │     "anthropic": {
    │       "total_quota": 1000000,
    │       "used_today": 450000,
    │       "remaining": 550000,
    │       "last_updated": "2026-08-29T12:00:00Z",
    │       "update_source": "local_ledger"  // not from API (free)
    │     },
    │     "openai": { ... },
    │     "local_llama": { ... }
    │   }
    │
    └─ agents.db
        ├─ agent_registration: {agent_id, name, capabilities, created_at}
        ├─ prediction_history: {agent_id, task_id, prediction, actual, error_margin, timestamp}
        └─ reputation_log: {agent_id, score, reason, timestamp}
```

**Invariant:** No external API calls to check quota. All data is local, historical, or provided by tasks themselves.

**Update mechanism:** 
- When task completes, update `pools.json` with actual usage
- Compute burn rate: tokens_used / time_elapsed
- Predict next quota based on rate and historical patterns

---

### Layer 2: AGENT PREDICTION MODULE
**Purpose:** Agents predict resource usage without external verification

```
Agent flow:

Input: New task
  {
    "task_id": "t_001",
    "workload": "summarize document",
    "document_size_mb": 10,
    "constraints": {
      "latency_budget_ms": 30000,
      "max_tokens": 100000,
      "required_model": "claude-3.5-sonnet"
    }
  }

Agent reasoning (using local ledger):
  1. Look at historical data: tasks of this size typically use 2-3K tokens
  2. Add 20% buffer for uncertainty: 3.6K tokens predicted
  3. Check ledger: Anthropic has 550K remaining (plenty)
  4. Check burn rate: Anthropic losing ~5K tokens/hour
  5. Predict: "Task will use 3.6K tokens, have 550K available, safe"
  6. Confidence: 0.92 (based on how often similar predictions were accurate)

Output: Prediction
  {
    "agent_id": "agent_alpha",
    "prediction": {
      "model": "claude-3.5-sonnet",
      "predicted_tokens": 3600,
      "confidence": 0.92,
      "reasoning": "Historical avg 2.5K + 20% buffer, 6 similar tasks, all within margin",
      "fallback_model": "gpt-4-turbo" // if Anthropic quota exhausted
    },
    "stake": 50.0,  // reputation points at risk
    "timestamp": "2026-08-29T12:00:00Z"
  }
```

**Agent learning mechanism:**
```
For each prediction, track:
  - Predicted tokens: 3600
  - Actual tokens: 3450
  - Error: (3450 - 3600) / 3600 = -4.2% (accurate)
  - Timestamp: t
  
Accuracy score: 1.0 - abs(error_margin)
Reputation update: current_reputation * (1 + 0.05 * accuracy_score)

Over 100 predictions:
  Agent with 90% accuracy score: reputation multiplied by ~1.05^100 = 131x
  Agent with 70% accuracy score: reputation multiplied by ~1.035^100 = 28x
  Agent with 50% accuracy score: reputation multiplied by ~1.025^100 = 12x
```

---

### Layer 3: DISPATCHER
**Purpose:** Route tasks to pools based on agent predictions and reputation

```
Dispatch logic:

Input: Task + Agent prediction with reputation score

Decision tree:
  1. Is this agent high-reputation (>0.90)?
     YES → APPROVE prediction immediately
     NO → Continue
  
  2. Is predicted tokens < (available_tokens * 0.5)?
     YES → APPROVE with warning (risky if burn rate changes)
     NO → Continue
  
  3. Compare against multiple agent predictions?
     IF agent_1 predicts 3.6K with 0.95 reputation
     IF agent_2 predicts 5.2K with 0.70 reputation
     → Choose agent_1's pool (Anthropic)
     NO → Continue to manual decision
  
  4. Fallback: Use most-available pool
     Default pool selection: argmax(available_tokens)

Output: Dispatch decision
  {
    "task_id": "t_001",
    "approved": true,
    "model": "claude-3.5-sonnet",
    "pool": "anthropic",
    "predicted_usage": 3600,
    "confidence": 0.92,
    "fallback": "gpt-4-turbo",
    "retry_on_exhaustion": true,
    "timestamp": "2026-08-29T12:00:01Z"
  }

If approval denied:
  {
    "task_id": "t_001",
    "approved": false,
    "reason": "No agent confident enough (max 0.65) + insufficient quota buffer",
    "suggestions": [
      "Wait 15 minutes for quota refresh",
      "Use fallback model (gpt-4-turbo)",
      "Reduce task scope"
    ]
  }
```

---

### Layer 4: VERIFICATION & OUTCOME TRACKING
**Purpose:** Measure actual resource usage and bind to predictions

```
Task execution flow:

1. Before dispatch:
   - Save prediction to ledger
   - Agent stakes reputation points
   - Record timestamp

2. During execution:
   - Monitor actual tokens consumed
   - Track latency
   - Detect quota exhaustion early
   
3. After completion:
   - Record actual metrics: {tokens_used, latency, status}
   - Compare to prediction
   - Calculate error: abs(predicted - actual) / actual
   
4. Verification record:
   {
     "task_id": "t_001",
     "agent_id": "agent_alpha",
     "predicted_tokens": 3600,
     "actual_tokens": 3450,
     "error_percentage": -4.2,
     "accuracy_score": 0.958,  // 1.0 - abs(error)
     "latency_ms": 12500,
     "status": "success",
     "pool_remaining_after": 546550,
     "timestamp": "2026-08-29T12:00:15Z"
   }

5. Reputation update:
   - Agent's accuracy track record updated
   - Confidence score adjusted
   - Reward/penalty applied
   - Ledger appended
```

---

### Layer 5: REPUTATION SYSTEM
**Purpose:** Build verifiable agent credibility tied to prediction accuracy

```
Reputation model:

Agent state:
  {
    "agent_id": "agent_alpha",
    "reputation_score": 1000,  // starts at 1.0, scales logarithmically
    "predictions_made": 156,
    "predictions_accurate": 142,  // within 10% margin
    "accuracy_percentage": 91.0,
    "confidence_in_predictions": 0.92,
    "specialized_in": ["summarization", "analysis"],
    "weak_at": ["coding_generation"],
    "credibility_tier": "gold"  // based on track record
  }

Credibility tiers (reputation-based):
  - Red: <0.60 accuracy, reputation sinking
  - Yellow: 0.60-0.75 accuracy, learning
  - Blue: 0.75-0.85 accuracy, trusted for small tasks
  - Green: 0.85-0.92 accuracy, trusted for medium tasks
  - Gold: >0.92 accuracy, trusted for large tasks
  - Diamond: >0.97 accuracy + >100 predictions, can negotiate pools

Trust score for dispatch:
  trust_score = (accuracy_percentage / 100) ^ predictions_made
  
  Agent with 90% accuracy:
    After 10 predictions: 0.90^10 = 0.349 (getting there)
    After 50 predictions: 0.90^50 = 0.00515 (exponentially penalizes variation)
    
  Better: weighted average with recency
    recent_accuracy = mean(last_20_predictions) * 0.7
    historical_accuracy = overall_accuracy * 0.3
    trust_score = recent_accuracy + historical_accuracy
```

**Cryptographic binding:**
```
For each prediction verification, create signed record:

cert = sign({
  agent_id: "agent_alpha",
  task_id: "t_001",
  prediction: 3600,
  actual: 3450,
  accuracy: 0.958,
  timestamp: "2026-08-29T12:00:15Z",
  ledger_hash: "sha256(...)"  // proof it was recorded
}, agent_private_key)

This creates an unforgeable record:
  - Proves agent made this prediction at this time
  - Proves actual outcome was measured
  - Proves it was added to ledger
  - Can be independently verified
  - Survives disputes
```

---

## DATA MODELS (Canonical Schemas)

### Prediction
```javascript
{
  id: "pred_001",
  agent_id: string,
  task_id: string,
  
  // Core prediction
  predicted_metrics: {
    tokens: number,
    latency_ms: number,
    cost_usd: number
  },
  
  // Metadata
  confidence: number,  // 0-1
  reasoning: string,   // why agent thinks this
  historical_context: {
    similar_tasks_count: number,
    accuracy_on_similar: number,  // 0-1
    last_similar_at: timestamp
  },
  
  // Staking
  stake: {
    reputation_points: number,
    at_risk: boolean
  },
  
  // Routing
  preferred_model: string,
  fallback_models: string[],
  
  timestamp: timestamp,
  signature: hex  // @baton/sign
}
```

### Outcome
```javascript
{
  id: "outcome_001",
  task_id: string,
  prediction_id: string,
  agent_id: string,
  
  // Actual metrics
  actual_metrics: {
    tokens_used: number,
    latency_ms: number,
    cost_usd: number,
    status: "success" | "quota_exceeded" | "timeout" | "error"
  },
  
  // Comparison to prediction
  accuracy: {
    tokens_error_pct: number,  // (actual - predicted) / predicted
    latency_error_pct: number,
    within_tolerance: boolean,  // error < 15%
    accuracy_score: number  // 1.0 - abs(error_pct)
  },
  
  // Pool state after
  pool_state_after: {
    model: string,
    remaining_tokens: number,
    burn_rate: number  // tokens/hour
  },
  
  timestamp: timestamp,
  signature: hex  // @baton/sign
}
```

### ReputationSnapshot
```javascript
{
  agent_id: string,
  timestamp: timestamp,
  
  // Accuracy metrics
  total_predictions: number,
  accurate_predictions: number,  // within 15% margin
  accuracy_percentage: number,
  
  // Confidence
  confidence_score: number,  // 0-1
  confidence_trend: "improving" | "stable" | "declining",
  
  // Credibility
  credibility_tier: string,
  trust_rank: number,  // percentile among all agents
  
  // Specialization
  strengths: { task_type: number }[],  // accuracy by domain
  weaknesses: { task_type: number }[],
  
  // Stakes
  total_staked: number,
  winning_stakes: number,
  stake_win_rate: number,
  
  signature: hex  // @baton/sign
}
```

---

## INTEGRATION POINTS (with existing BATON)

### How @baton/align helps
```
When agent makes prediction, compare against:
  - Similar agents' predictions
  - Historical predictions for same task type
  
Detect drift in agent behavior:
  "Agent usually predicts 3-4K tokens, now predicting 50K"
  → Alert: agent may be learning something new or corrupted
  
@baton/align flags anomalies before dispatch
```

### How @baton/sign helps
```
Every prediction and outcome is signed:
  - Agent cryptographically commits to prediction
  - Outcome is cryptographically verified
  - Reputation updates are provable
  - Auditable: who predicted what, when, and who was right
  
Build market: agents can prove their track record to earn trust
```

### How @baton/registry helps
```
Registry tracks:
  - Agent identity and credentials
  - Agent's public key (for signature verification)
  - Agent's current reputation score
  - Agent's declared specializations
  
Enables cross-team agent reputation:
  - Team A's agent can query Team B's registry
  - Verify agent's track record cryptographically
  - Decide whether to trust it
```

### How @baton/stake helps
```
Reputation as stake:
  - Agent builds reputation through accurate predictions
  - Reputation is stake in future predictions
  - Can be slashed on bad predictions
  - Recovers when predictions are accurate
  
Sybil-resistant: building reputation takes time and accuracy
```

---

## USER WORKFLOWS

### Workflow 1: Platform Engineer (Setup)
```
1. Install BATON dispatcher
2. Configure pools:
   {
     "anthropic": { api_key: "...", monthly_budget: $500 },
     "openai": { api_key: "...", monthly_budget: $200 },
     "local": { model: "llama-70b", path: "/models/llama" }
   }
3. Register agents (your LLM agents that will make predictions)
4. Start ledger tracking
5. Set accuracy thresholds for dispatch approval
```

### Workflow 2: Agent (Making Predictions)
```
Agent receives task:
  1. Query local ledger: "How much quota is available?"
  2. Check reputation: "What's my current confidence score?"
  3. Look at historical data: "Similar tasks usually use how much?"
  4. Make prediction: "This task will use 3.6K tokens, confidence 0.92"
  5. Stake reputation: "I'm confident in this"
  6. Wait for dispatch decision
  7. If approved: execute task, report actual metrics
  8. Reputation updated based on accuracy
```

### Workflow 3: Operations (Monitoring)
```
Dashboards available:
  - Pool health: Quota remaining per model, burn rate
  - Agent performance: Accuracy leaderboard, tier assignments
  - Task success rate: % of tasks completed without quota exhaustion
  - Cost tracking: Spend per model, cost per task type
  - Anomalies: Agents with degrading accuracy, pools running low
  
Alerts:
  - Agent accuracy dropping below threshold
  - Pool burn rate spiking
  - Quota exhaustion predicted within N hours
  - Agent predictions consistently underestimating
```

---

## FAILURE MODES & HANDLING

### Failure: Agent consistently underestimates
```
Symptom: Agent predicts 3K, task uses 8K (166% overestimate)
Pattern: Happens in 5/10 recent tasks
Response:
  1. Flag agent's credibility tier → yellow (from green)
  2. Reduce reputation score
  3. Exclude agent from high-confidence dispatch decisions
  4. Send alert: "Agent may need retraining"
  5. Stop accepting large predictions from this agent
  6. Small tasks still okay (learns gradually)
```

### Failure: Quota exhaustion mid-task
```
Preventive: Predictions should avoid this via dispatcher logic
But if it happens:
  1. Pause task execution
  2. Log: agent made prediction that failed
  3. Drop agent's reputation significantly
  4. Retry on fallback model (if specified)
  5. Alert engineering team
  6. Investigate: why did predictor fail?
```

### Failure: Ledger becomes stale
```
If no tasks run for 8 hours:
  1. Pool estimates become unreliable
  2. Burn rate calculation becomes invalid
  3. Predictions lose confidence
  4. System enters "conservative mode"
  5. Only approve high-reputation agents
  6. Suggest quota refresh from APIs
  
Resolution: Manual pool state update or queue backlog of tasks
```

### Failure: Collusion (multiple agents lying)
```
Attack: Agents conspire to exhaust quota
Prevention:
  1. Stake mechanism (each agent has skin in game)
  2. Reputation penalties for inaccuracy
  3. Diversity: don't trust single agent completely
  4. Majority voting: require agreement from high-reputation agents
  5. Anomaly detection: if too many agents wrong simultaneously, escalate
```

---

## PERFORMANCE REQUIREMENTS

### Latency
```
Query: "Can this task fit in Anthropic pool?"
  - Local ledger lookup: <10ms
  - Reputation score fetch: <5ms
  - Prediction request: <100ms (depends on agent speed)
  Total: <150ms (goal: don't add significant overhead to dispatch)
```

### Throughput
```
Expected workload:
  - 1000 tasks/day per team
  - 3-5 agents per team
  - 10-50 teams (pilot to scale)
  
System capacity:
  - 50,000 predictions/day
  - 50,000 outcomes/day
  - Ledger DB: append-only, no deletion
  
Storage:
  - Each record: ~500 bytes
  - 100,000 records/day × 500 bytes = 50 MB/day
  - Annual: 18 GB (still fits on standard volume)
```

### Availability
```
Ledger must always be available (dispatch depends on it)
Agents must handle ledger unavailability gracefully:
  - Fall back to default strategy (use most-available pool)
  - Predictions made with lower confidence
  - System degrades gracefully, doesn't crash

Backup & recovery:
  - Ledger replicated to persistent storage
  - WAL (write-ahead log) for durability
  - Snapshot every 1 hour
```

---

## INTEGRATION WITH EXISTING STACK

```
Current BATON:
  ├─ @baton/align (paraphrase diff)
  ├─ @baton/sign (cryptographic signing)
  ├─ @baton/registry (agent discovery)
  ├─ @baton/stake (reputation basics)
  ├─ @baton/swarm (LLM generation pipeline)
  └─ baton-ui (frontend)

New layers:
  ├─ @baton/ledger (event log + pool state)
  ├─ @baton/prediction (agent prediction module)
  ├─ @baton/dispatcher (routing logic)
  ├─ @baton/verification (outcome tracking)
  ├─ @baton/reputation (score calculation)
  └─ @baton/poolmanager (quota lifecycle)

UI additions:
  ├─ Pool health dashboard
  ├─ Agent leaderboard
  ├─ Task history browser
  ├─ Prediction drill-down
  └─ Reputation audit trail
```

---

## SUCCESS METRICS

### For platform engineers
- Zero tasks failed due to quota exhaustion (target: 100%)
- Prediction accuracy of best agents: >90%
- Cost per task: predictable and optimized
- Time to detect quota exhaustion: <15 min before actual failure

### For agents (LLM systems)
- Reputation score builds over time (no plateaus)
- Accuracy is rewarded (agents get dispatched more)
- Inaccuracy is punished (reputation recovers slowly)
- Specialization is recognized (strong in some domains, weak in others)

### For business
- Waste elimination: no more failed $1K tasks due to quota
- Cost predictability: can forecast monthly LLM spend ±10%
- Multi-vendor lock-in prevention: clear metrics on who works best
- Trust automation: humans stop approving tasks manually

---

## ROADMAP (no timeline, just priority)

### Phase 1: Core (MVP)
- Ledger system (append-only event log)
- Simple dispatcher (approve/reject based on quota)
- Basic reputation tracking (accuracy scoring)
- Manual pool management (CSV import)

### Phase 2: Intelligence
- Agent prediction module (local history-based)
- Burn rate prediction (exponential smoothing)
- Credibility tiers (red/yellow/green/gold)
- Anomaly detection (agent behavior drift)

### Phase 3: Optimization
- Multi-agent voting (consensus on pools)
- Fallback routing (automatic retry on exhaust)
- Cost optimization (choose cheapest pool that works)
- Specialization detection (which agents are best at what)

### Phase 4: Market
- Cross-organization reputation (registry-based)
- Agent credibility marketplace (trade agents based on reputation)
- Prediction futures (bet on agent accuracy)
- Formal game theory analysis (proof of mechanism)

---

## OPEN QUESTIONS (for you to decide)

1. **Scope of ground truth:** What counts as "verified"?
   - Just token count? Or also latency, cost, output quality?
   
2. **Multi-model dependencies:** Can a task use multiple models in sequence?
   - E.g., summarize with Claude, then code with GPT-4?
   - How do we predict tokens for that?

3. **Human in the loop:** When should humans override automated dispatch?
   - Safety-critical tasks? Expensive tasks? Untrusted agents?

4. **Privacy:** Can agents see each other's predictions?
   - Or is prediction history private?

5. **Mechanism design:** What are the economic incentives?
   - Can agents sell their predictions? Buy others'?
   - Real money or reputation currency?

6. **Integration with existing BATON:** Do you keep the paraphrase chain?
   - Or pivot entirely to quota management?

---

**This is a complete product, not a simulation. Ready to build?**
