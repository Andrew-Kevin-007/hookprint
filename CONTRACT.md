# HOOKPRINT — The Contract

**This file is frozen. Every other piece of the project is written against it.**

If a shape here changes after work has started, every task sheet, every backend task, and the UI all break at once. **Nobody changes this file without Kevin.**

---

## The `Finding` object

One detected mechanic. This is the only object that moves between components.

```json
{
  "id": "f_001",
  "mechanism": "infinite_scroll",
  "display_name": "Infinite Scroll",
  "confidence": "high",
  "evidence": {
    "file": "https://example.com/static/main.js",
    "line": 4412,
    "column": 18,
    "snippet": "observer.observe(sentinel); // fetchNextPage()"
  },
  "observed": {
    "summary": "7 automatic content loads, 0 user-confirmation events",
    "metrics": { "auto_loads": 7, "user_confirmations": 0 }
  },
  "action": {
    "supported": true,
    "label": "Disable infinite loading",
    "action_id": "disable_infinite_scroll"
  }
}
```

### Field rules

| Field | Type | Rule |
|---|---|---|
| `id` | string | Unique within one scan. `f_001`, `f_002`, … |
| `mechanism` | string | **Must** be one of the six values below. Nothing else, ever. |
| `display_name` | string | Human-readable label for the UI. |
| `confidence` | string | **Must** be `high`, `medium`, or `low`. |
| `evidence.file` | string | Full URL of the JS file. |
| `evidence.line` | integer | 1-indexed line number. |
| `evidence.column` | integer | 1-indexed column. |
| `evidence.snippet` | string | The actual source text at that location. |
| `observed.summary` | string | Plain-English statement of what was *measured happening*, not what the code says. |
| `observed.metrics` | object | Free-form counters backing the summary. |
| `action.supported` | boolean | Whether we can safely switch this off. |
| `action.label` | string | Button text. **Absent when `supported` is `false`.** |
| `action.action_id` | string | Identifier the extension dispatches on. **Absent when `supported` is `false`.** |

### Allowed `mechanism` values — frozen

```
infinite_scroll
autoplay
variable_interval_refetch
countdown_timer
scarcity_message
unknown
```

### Allowed `confidence` values — frozen

```
high
medium
low
```

---

## The `Manifest` object

The full result of scanning one page. This is what the UI renders.

```json
{
  "url": "https://example.com/feed",
  "scanned_at": "2026-08-28T14:30:00Z",
  "findings": [ /* Finding objects */ ],
  "dropped": [
    {
      "proposed_mechanism": "variable_interval_refetch",
      "reason": "no resolvable node"
    }
  ]
}
```

---

## The two rules that are not negotiable

### 1. Evidence binding — no resolvable node means no finding

**A candidate mechanic that cannot be tied to a real file, line, and source snippet does not become a `Finding`.** It goes in `dropped` with a reason.

This is not a nicety. It is the thing that makes a claim checkable — a judge clicks a row and the actual code is there. A finding we cannot point at is an accusation, and we do not make accusations.

The `dropped` array is not a failure log. It is the receipt for this discipline, and it is what we show when someone asks how we know we are not flagging everything.

### 2. Signal, never proof of intent

Variable-interval event timing is **evidence consistent with** a variable-ratio reward schedule. It is not proof that anyone designed it that way.

**Wording that is allowed:**
> "Variable-interval event timing — a behavioural signal consistent with a variable-ratio reward schedule."

**Wording that is banned, in code comments, UI copy, README, and on stage:**
- "slot machine"
- "proof of manipulation"
- "this site is manipulating you"
- "dark pattern = illegal" / "detects DSA violations"

We report what is running and where. We do not assign intent, and we do not rule on legality.

---

## Component boundaries

| Component | Owner | Produces | Consumes |
|---|---|---|---|
| Instrumentation harness | Kevin | raw events + stack frames | the live page |
| Detectors | Kevin | `Finding` objects | raw events |
| Kill switches | Kevin | page state change | `action_id` |
| Backend `/classify` | local 8B tasks | `mechanism` + `confidence` | code snippet + trace |
| Bill of Materials UI | Teammate 1 (`ui` branch) | rendered panel | a `Manifest` |
| Test bench | Teammate 2 (`testbench` branch) | trap pages + answer key | nothing |

**Every component can be built and tested alone against this contract.** That is the point of freezing it.
