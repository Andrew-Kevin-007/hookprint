# real-corpus fixture — MANIFEST

**What this is.** Two markdown files, copied byte-for-byte (SHA-256 verified, see below) from
`D:\Tenori_Hack\ideation\`, where they were written on 2026-08-27 by two independent AI agent
sessions (`raven` and `zeus`) during this team's actual hackathon ideation process — before
BATON existed as a project. Nothing in these two files was written for, or edited for, this
fixture. Judges can open the originals in `D:\Tenori_Hack\ideation\` and diff them against this
directory to confirm that.

```
sha256(raven-deep-trust.md)          = 9de984b971701f00b29bf9d02145abccd5878d78df0f0645d01a332594583a80
sha256(zeus-confidence-routing.md)   = 2e56a5084465f8cb2c5b58860da76e65b305ab54b48d9d2af2a8284dd80a0f51
```
Both hashes are identical between `D:\Tenori_Hack\ideation\*` and this directory — confirmed
with `diff` (zero output) and `sha256sum` immediately before this manifest was written.

**Why full files, not excerpts.** Both files are small enough (62 KB / 27 KB) that trimming them
buys nothing and costs the strongest property this fixture has: a skeptical judge can be handed
the *original*, un-copied file in `ideation/` and told "diff it" — no editorial decision to
defend, nothing that could be accused of being cherry-picked.

---

## The chain

This is a real, three-hop paraphrase chain carrying one quantified claim — "Kevin's fleet's
confidence-value reporting rate: 2 of 252 dispatches, 0.79%" — across two documents written by
two different agents. The claim is restated in the agent's own words at each hop (no ID, no
copy-paste of the sentence) and the **base (252) survives the first restatement, then is
silently dropped at the second.**

| Hop | Role (BATON-equivalent) | File | Line | Exact text |
|---|---|---|---|---|
| 1 | Researcher (origin) | `raven-deep-trust.md` | **81** | *"**Kevin's fleet: 0.79%** — 2 of 252 dispatches carried the confidence value that 10 of ~18 configs require. **Two orders of magnitude below the worst published degradation.**"* |
| 2 | Summariser (first restatement) | `zeus-confidence-routing.md` | **158** | *"Kevin's measurement, carried forward: confidence-reporting policy in **10 of ~18 agent configs (29 occurrences)**; **2 of 252 dispatch records carry a confidence value (0.79%)**; no consumer of the signal exists."* |
| 3 | Writer (second restatement) | `zeus-confidence-routing.md` | **173** | *"The literature measures instruction-following decay from ~100% down to **50–91%** under load, stacking, or distance. **Kevin's fleet reports 0.79%.** That is not the same regime — it is roughly **two orders of magnitude below** the worst published degradation."* |

### Confirming where the base is actually lost (read closely, not assumed)

- **Hop 1 → Hop 2: base survives.** Hop 1 says "2 of 252 dispatches." Hop 2, in a completely
  different document written by a different agent, restates it in its own words — "dispatches"
  becomes "dispatch records," the ordering changes, a parenthetical is added — but **"2 of 252"
  and "252" are both still explicitly present.** A reader of hop 2 alone can still recover the
  denominator. This is a genuine paraphrase (different wording, same document structure as the
  rest of zeus's file, not a copy of raven's sentence) that preserves the load-bearing fact.

- **Hop 2 → Hop 3: base is silently dropped.** Both hop 2 (line 158) and hop 3 (line 173) live in
  the *same* file (`zeus-confidence-routing.md`), 15 lines apart — line 158 is zeus's own
  restatement of raven's finding at the top of §6, and line 173 is zeus's own second restatement
  of that same finding at the bottom of §6, phrased as "the finding, stated precisely" for a
  head-to-head comparison against a published literature range. **This second restatement keeps
  the rate (0.79%) and drops the base entirely** — no "2 of," no "252," nothing a reader could
  use to recover the denominator. This is the exact **hop 2 → hop 3 edge**, not hop 1 → hop 2.

  This matters for a second reason, present in the source text itself: at line 173, the now
  baseless 0.79% is directly compared against a published range of "50–91%" and declared "roughly
  two orders of magnitude below" — a comparison that presupposes the two percentages share a
  comparable base. Whether they do is exactly what the missing denominator makes unverifiable.
  The corruption is not just an omission; it feeds directly into the sentence's own conclusion.

### Expected BATON finding

- **Claim:** "confidence value present in 2 of 252 Kevin-fleet dispatch records (0.79%)," minted
  from hop 1 (`raven-deep-trust.md:81`).
- **Hop 1 → Hop 2 alignment:** realigns cleanly (lexical + numeric overlap: "0.79%," "252," the
  fleet-reporting subject survive the rewrite). Diff result: **no fail-severity delta** — value,
  unit, and base all intact. This edge should render **gray**, not red.
- **Hop 2 → Hop 3 alignment:** realigns to the same origin claim (0.79% and the fleet-reporting
  subject are still enough signal to identify it as the same claim), but the diff on the aligned
  pair finds the denominator ("2 of 252" / "252") present at hop 2 and absent at hop 3 while the
  rate (0.79%) is unchanged. Expected class: **`denominator_loss`**. This is the edge that should
  render **red** in the UI, and the gate should return **REJECT** for this claim with the
  canonical value held at its hop-2 state.
- **Not expected:** `value_drift` (0.79% never changes across any hop) or `unit_drift` (the
  subject — confidence-value presence in fleet dispatch records — is stable in substance across
  all three restatements, only the surface wording changes).

### A second instance in the same corpus (noted, not built into this fixture)

`raven-deep-trust.md` documents its own second, independent corruption chain in the same
ideation round: a completion-rate figure written as `2/37 = 5%` (friday's completion rate) that
the file itself flags elsewhere in the corpus as propagating to multiple locations with an
inflated denominator (the true figure being `2/17`). This fixture does not include that second
chain — it is mentioned here only so a reader auditing this MANIFEST against the source files
understands it is not the same claim as the one documented above and is not accidentally
conflated with it.

---

## Provenance chain of custody

1. `D:\Projects\Stark-Core\state\dispatches.jsonl` — raw dispatch telemetry, read live by `raven`
   on 2026-08-27 (per `raven-deep-trust.md` line 9: "Read live from
   `D:\Projects\Stark-Core\state\dispatches.jsonl` at 19:2x on 2026-08-27").
2. `raven-deep-trust.md` — raven's ideation document, line 81, states the finding with its base
   intact. **Hop 1 / researcher-equivalent.**
3. `zeus-confidence-routing.md` — zeus's independent prior-art document, written the same day,
   restates raven's finding twice while researching a different question (whether
   confidence-based agent routing is prior art). Line 158 preserves the base.
   **Hop 2 / summariser-equivalent.**
4. `zeus-confidence-routing.md` line 173 — zeus's own later restatement, in the same document,
   drops the base. **Hop 3 / writer-equivalent.**

This chain is what BUILD-PLAN.md and CONTENT-BRIEF.md cite as BATON's primary demo evidence, and
it is reproduced verbatim in both of those documents (see `BUILD-PLAN.md` "Demo evidence" and
`CONTENT-BRIEF.md` §3). This MANIFEST independently re-derived and confirmed it by reading the
two source files directly rather than trusting that summary.
