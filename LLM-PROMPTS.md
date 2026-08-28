# Ready-to-paste prompts for the local model

Copy a block, paste it into PowerShell, read the answer. Server must be running — see `LOCAL-LLM.md`.

**Every block already includes `enable_thinking = $false`. Do not remove it** — Qwen3 returns an empty string without it, silently, with no error.

---

## Setup — paste once per PowerShell session

Defines `Ask-LLM`, so every prompt below is a one-liner.

```powershell
function Ask-LLM {
  param([string]$Prompt, [int]$MaxTokens = 400)
  $body = @{
    messages = @(@{ role = "user"; content = $Prompt })
    temperature = 0
    max_tokens = $MaxTokens
    chat_template_kwargs = @{ enable_thinking = $false }
  } | ConvertTo-Json -Depth 6 -Compress
  $r = Invoke-RestMethod -Uri http://localhost:8080/v1/chat/completions `
        -Method Post -ContentType "application/json" -Body $body
  $r.choices[0].message.content
}
```

Smoke test:
```powershell
Ask-LLM "Reply with only the word: ok"
```
Anything other than `ok` (especially an empty line) means the server isn't ready or the thinking flag was dropped.

---

## 1 · Classify a snippet

The core task. Verified working — returns `infinite_scroll`.

```powershell
Ask-LLM @"
Classify this JavaScript into EXACTLY ONE label from this list:
infinite_scroll, autoplay, countdown_timer, scarcity_message, variable_interval_refetch, unknown

Reply with ONLY the label. No explanation, no punctuation.

CODE:
const obs = new IntersectionObserver(e => { if (e[0].isIntersecting) fetchNextPage(); });
obs.observe(sentinel);
"@
```

Swap the code, keep everything else. **Always check the reply is one of the six strings before using it.**

---

## 2 · Write a one-line observed-behaviour summary

Fills `observed.summary` in a Finding.

```powershell
Ask-LLM @"
Write ONE sentence stating what was measured. State only counts and facts.
Do NOT claim intent. Do NOT use the words: manipulate, slot machine, trick, dark pattern, deceptive.

MEASUREMENTS:
- 7 automatic content loads
- 0 user click events between loads
- triggered by IntersectionObserver on a bottom sentinel

Reply with ONLY the sentence.
"@
```

---

## 3 · Name a mechanic for the UI

```powershell
Ask-LLM -MaxTokens 30 @"
Give a short human-readable display name, 2-3 words, Title Case, for this mechanic id:
infinite_scroll

Reply with ONLY the name.
"@
```

---

## 4 · Small, fully-specified code task

The model cannot design. Give it the signature, the rules, and the file — never "figure out the best approach."

```powershell
Ask-LLM -MaxTokens 800 @"
Write ONE JavaScript function. No explanation, no markdown fences, code only.

SIGNATURE:
function parseStackFrame(line)

INPUT: a single V8 stack trace line, either format:
  "    at fnName (https://site.com/app.js:120:8)"
  "    at https://site.com/app.js:120:8"

OUTPUT: { file, line, column } with line and column as numbers.
Return null if the line matches neither format.

RULES:
- Pure function. No side effects, no globals, no console.
- Do not throw. Return null on anything unparseable.
- No dependencies.
"@
```

---

## Rules for writing your own

**Do:**
- One small task per call
- State the exact allowed outputs and demand one verbatim
- Say "Reply with ONLY..." — it pads otherwise
- Short snippets: a function, never a whole file
- Validate every reply against your allowed list

**Don't:**
- Ask it to decide anything open-ended or choose an approach
- Send a whole file and ask what's interesting
- Assume it remembers a previous call — every call is cold
- Let its output reach a user or a `Finding` unvalidated

**A `Finding` is a public claim about someone's website.** Unvalidated model output must never become one.

---

## If it fails twice, stop

Hand the task to a Claude agent. The local model exists to buy hours back — forty minutes arguing with an 8B costs more than the task was worth.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Empty reply | `enable_thinking` missing, or `max_tokens` too low |
| Connection refused | Server not started, or still loading (`/health` returns 503 for 30-60s) |
| `curl` behaves oddly | In PowerShell `curl` aliases `Invoke-WebRequest` — use `curl.exe` |
| Wildly wrong label | Snippet too long, or the allowed list wasn't restated in the prompt |
