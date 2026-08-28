# Running the local model

HOOKPRINT uses a local 8B model to classify code snippets into mechanic types. **It runs entirely on this machine — no page content ever leaves it.** That is a design requirement, not a preference: a tool that audits your attention while uploading your browsing history has reproduced the problem it claims to solve.

**The demo must work with this server switched off.** The backend falls back to deterministic matching whenever the model is unreachable. Assume it will be off on stage — treat the model as an enhancement, never a dependency.

---

## 1. What you actually have (verified on this machine)

| | |
|---|---|
| **Binary** | `D:\xlkg-models\llama.cpp\bin\llama-server.exe` — **not on PATH, use the full path** |
| **Model (default)** | `D:\xlkg-models\gguf\Qwen3-8B-Q4_K_M.gguf` |
| **Model (alt)** | `D:\xlkg-models\gguf\Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf` |

There is also an Ollama model store at `D:\ollama\models`, but the `ollama` binary is not on PATH. **Use llama.cpp — it's present and working.**

---

## 2. Start the server

One line, from anywhere:

```bash
"D:/xlkg-models/llama.cpp/bin/llama-server.exe" -m "D:/xlkg-models/gguf/Qwen3-8B-Q4_K_M.gguf" --port 8080 --ctx-size 4096 --n-gpu-layers 99 --temp 0 --top-k 1
```

Leave that terminal open — it holds the server. First load takes 30-60s while weights move to VRAM.

| Flag | Why |
|---|---|
| `--port 8080` | The backend expects this. Don't change it without changing `backend/`. |
| `--n-gpu-layers 99` | Offload everything to CUDA. **If it crashes or logs a VRAM failure, drop to `--n-gpu-layers 20` or `0`** — slower, but it runs. |
| `--ctx-size 4096` | Plenty. We only ever send short snippets. |
| `--temp 0` and `--top-k 1` | **Not optional.** We need deterministic, repeatable classification. A model that answers differently on two runs of the same page makes the demo unreproducible. |

⚠️ **Expected warning, not an error:** `failed to fit params to free device memory: n_gpu_layers already set by user to 99`. That's llama.cpp saying it won't auto-tune because you set the value explicitly. It only matters if the server then dies — if it reaches `server is listening`, ignore it.

| Flag | Why |
|---|---|
| `--port 8080` | The backend expects this. Don't change it without changing `backend/`. |
| `--n-gpu-layers 99` | Offload everything to CUDA. Drop to `0` if you hit VRAM errors — it'll be slow but it'll run. |
| `--ctx-size 4096` | Plenty. We only ever send short snippets. |
| `--temp 0` and `--top-k 1` | **Not optional.** We need deterministic, repeatable classification. A model that answers differently on two runs of the same page makes the demo unreproducible. |

If `llama-server` isn't on your PATH, use the full path to the binary in your llama.cpp build (often `llama.cpp\build\bin\llama-server.exe`).

---

## 3. Verify it's up

```bash
curl http://localhost:8080/health
```

`{"status":"ok"}` means ready. **`{"error":{"message":"Loading model",...,"code":503}}` is normal for the first 30-60s** — wait, don't restart it.

---

## 🔴 4. The Qwen3 trap — read this or you will lose an hour

**Qwen3 has "thinking mode" ON by default. It burns your entire token budget on internal reasoning and returns an EMPTY string.** No error. No warning. Just `''`.

Verified on this machine: the same classification request returned `''` with `max_tokens: 30`, and `'infinite_scroll'` once thinking was disabled.

**Every request must send this:**

```json
"chat_template_kwargs": { "enable_thinking": false }
```

In Python:
```python
requests.post("http://localhost:8080/v1/chat/completions", json={
    "messages": [{"role": "user", "content": prompt}],
    "temperature": 0,
    "max_tokens": 400,
    "chat_template_kwargs": {"enable_thinking": False},   # ← REQUIRED
})
```

**Working round-trip, verified:**

```bash
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Classify this JavaScript into EXACTLY ONE of: infinite_scroll, autoplay, countdown_timer, scarcity_message, variable_interval_refetch, unknown.\n\nReply with ONLY the label.\n\nCODE:\nconst obs = new IntersectionObserver(e => { if (e[0].isIntersecting) fetchNextPage(); });\nobs.observe(sentinel);"}],"temperature":0,"max_tokens":400,"chat_template_kwargs":{"enable_thinking":false}}'
```
→ returns `infinite_scroll`, `finish_reason: stop`.

**If you ever get an empty reply, this is why.** Either the flag is missing or `max_tokens` is too low. Do not debug it as a prompt problem.

Llama-3.1-8B has no thinking mode — swapping to it also avoids this entirely, at some cost in instruction-following.

---

## 4. Point the backend at it

The backend defaults to **deterministic matching** — no model needed. To use the model, add the query param:

```
POST http://localhost:8000/classify?use_model=true
```

Verify the fallback actually works, because this is what protects the demo:

```bash
# 1. With the model server running
curl -X POST "http://localhost:8000/classify?use_model=true" \
  -H "Content-Type: application/json" \
  -d "{\"snippet\":\"new IntersectionObserver(cb)\",\"trace\":[]}"

# 2. Now STOP the llama-server and run the exact same command again.
#    It must still return a sensible answer, with confidence "low".
```

**If step 2 errors instead of falling back, that is a bug and it is a demo-killing one.** Fix it before anything else.

---

## Writing prompts for this model

This is an 8B model. It does not reason — it pattern-matches. It is measurably good on short, rigid, structured input and degrades badly on long unstructured input. Write for that:

**Do:**
- Give it one small, self-contained task per call
- State the exact allowed output values and demand one of them, verbatim
- Keep the input snippet short — a function, not a file
- Give a worked example of the exact output format
- Always validate the response against the allowed list before trusting it

**Don't:**
- Ask it to decide anything open-ended, or to choose an approach
- Send it a whole file and ask what's interesting
- Assume it remembers anything from a previous call — every call is cold
- Let its output reach a user without validation

**The rule that matters:** if a response isn't in the allowed value list, throw it away and use the deterministic path. Never pass an unvalidated model output into a `Finding`, because a `Finding` is a public claim about somebody's website.

---

## If it fails twice, stop

If a task fails its check twice with the local model, hand it to a Claude agent instead. This model exists to buy hours back — spending forty minutes arguing with an 8B costs more than the task was worth.
