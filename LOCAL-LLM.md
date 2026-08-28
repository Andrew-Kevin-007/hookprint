# Running the local model

HOOKPRINT uses a local 8B model to classify code snippets into mechanic types. **It runs entirely on this machine — no page content ever leaves it.** That is a design requirement, not a preference: a tool that audits your attention while uploading your browsing history has reproduced the problem it claims to solve.

**The demo must work with this server switched off.** The backend falls back to deterministic matching whenever the model is unreachable. Assume it will be off on stage — treat the model as an enhancement, never a dependency.

---

## 1. Find your model file

Models live in `D:\xlkg-models`. List what's actually there:

```bash
ls "D:/xlkg-models"/*.gguf
```

You want a `.gguf` file — Qwen3-8B or Llama-3.1-8B, ideally a `Q4_K_M` or `Q5_K_M` quant (good speed/quality tradeoff on consumer GPUs).

If there are no `.gguf` files, look one level deeper:
```bash
find "D:/xlkg-models" -name "*.gguf" -maxdepth 3
```

---

## 2. Start the server

```bash
llama-server ^
  -m "D:\xlkg-models\<YOUR-MODEL>.gguf" ^
  --port 8080 ^
  --ctx-size 4096 ^
  --n-gpu-layers 99 ^
  --temp 0 ^
  --top-k 1
```

On Git Bash / PowerShell use `\` line continuation or put it on one line.

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

Then a real round-trip:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"Reply with only the word: ok\"}],\"temperature\":0,\"max_tokens\":5}"
```

You should get back a JSON body containing `ok`. If you do, the backend can talk to it.

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
