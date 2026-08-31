hi hello vanakam# QUORUM 

[![tests](https://img.shields.io/badge/tests-413%2F414%20passing-brightgreen)](#testing)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![built for](https://img.shields.io/badge/Tenori%20Hack-Track%2002-8A2BE2)](PROJECT-REFERENCE.md)

A trust-aware AI execution router. It profiles a task, partitions it into
context-safe batches, routes each batch to whichever provider is *predicted*
to do the best job on it — not whichever is cheapest — executes every batch
in a fresh context, merges the results with cross-batch contradiction
detection, scores the merged output's quality, and signs the whole execution
trace. A multi-provider run comes out verifiable after the fact, not just
hoped to have gone well.

Built for **Tenori Hack**, Track 02 (Agentic Web, Swarms & Harnesses), Team
14. The deterministic corruption-detection engine at the core of this
(`packages/align`) was the project's original submission, HOOKPRINT, before
the pivot to a full router built around it. See `PROJECT-REFERENCE.md` for
the complete architecture and history, and `BUILD-PLAN.md` for where the
build currently stands — this file covers the CLI and the five packages
behind it.

## Quick start

```bash
git clone <this-repo>
cd Tenori_Hack
npm install
npm link          # puts a global `quorum` command on your PATH
```

`npm link` backs the `quorum` command with `bin/quorum.js` in this checkout
— edits to the source take effect immediately, no reinstall needed. Requires
**Node ≥20** (`package.json`'s `engines` field; this repo is developed on
Node 24).

```bash
cp .env.example .env    # or just run `quorum init` below — it does this for you
quorum init              # prompts for whichever provider keys you have; every one is optional
quorum run "summarize the attached spec into five action items"
```

`quorum init` is safe to re-run any time — it only asks about what's still
missing, and exits cleanly instead of hanging if there's no TTY to prompt
on. Run bare `quorum` afterward for a status check (providers configured,
Supabase mirror on/off, logged in or not) plus a next-step nudge.

**Not yet published to npm.** `package.json` still has `"private": true`
and the name `quorum`. Verified directly against the real registry
(`npm view quorum`): that name is already taken by an unrelated package
from a different maintainer, so publishing under it isn't possible as-is.
The intended published name is `quorumcli` (confirmed available); the
command itself stays `quorum` regardless of what the npm package is called.
See `DEPLOYMENT.md` for the full `npm publish --dry-run` audit — what it
already fixed (a missing `version` field, a cosmetic `bin` path warning)
and what's still open (an unhandled ledger-write failure under a real
global install).

## Commands

Reference: `quorum --help`.

| Command | What it does |
|---|---|
| *(no command)* | Welcome screen — what's configured, what isn't, what to run next. |
| `quorum init` | First-run setup: create `.env`, prompt for any missing provider key, offer to log in. |
| `quorum test` | Run every package's test suite (align, sign, registry, stake, dispatch) and print a PASS/FAIL summary per package plus a total. |
| `quorum bench [--raw]` | Run the real corruption benchmark (`bench/run.js`) against the labelled corpus and print precision/recall/false-positive rate. `--raw` scores document-granularity text instead of curated focus spans. |
| `quorum campaign` | Run the Phase 3 degradation-measurement campaign (`bench/degradation/`) for real, against every provider with a credential env var present. Providers with no key are skipped, not fatal. |
| `quorum run <task>` / `quorum run --file <path>` | Run one real task through the full dispatch pipeline (intake → profile → route → execute → merge → score → sign → verify) against whichever providers actually have credentials in `.env`. Records real ledger events locally (`~/.quorum/run-ledger.jsonl`, or `%LOCALAPPDATA%\quorum` on Windows) and, if `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` are set, mirrors them to Supabase for the live dashboard. |
| `quorum login` | Log in via the browser (opens `WEB_ORIGIN`'s login page, polls for approval, stores a session locally). |
| `quorum logout` | Revoke and clear the locally stored session. |
| `quorum whoami` | Print the wallet address of the current session, or whether you're logged out / your session expired. |
| `quorum --help` / `quorum help` | Show the full command list. |

## Architecture

An npm workspaces monorepo (`packages/*`), ESM throughout
(`"type": "module"`). Five packages, in pipeline order:

| Package | Role | Tests |
|---|---|---|
| [`align`](packages/align) | The corruption-detection core. Re-identifies a paraphrased restatement against the claim it came from — with no ID ever carried downstream — then diffs the pair for four corruption classes: value drift, unit drift, denominator loss, caveat loss. Deterministic, zero dependencies, no network, no LLM in the checking path. | 151/151 |
| [`sign`](packages/sign) | ed25519 signing and verification over canonical claim bundles. `node:crypto` only, zero dependencies. | 11/11 |
| [`registry`](packages/registry) | Explicit state transitions (propose/derive/correct/challenge/attest) on top of `align`'s write gate, plus equivocation detection and replay protection. Zero third-party dependencies. | 76/76 |
| [`stake`](packages/stake) | The on-chain enforcement half: `AgentStake.sol` (Solidity/Hardhat) holds a stake keyed by a normal EVM address and lets one designated arbiter slash it once a claim is proven false off-chain. See "On-chain staking" below. | 31/31 |
| [`dispatch`](packages/dispatch) | The router itself — provider profiling, route planning, execution against six provider adapters (Anthropic, OpenAI, Groq, Cerebras, Gemini, OpenRouter), cross-batch merge with contradiction detection, quality scoring, signed trace, and the local + optional Supabase ledger. | 144/145 (1 skipped) |

The CLI (`bin/quorum.js`) that ties these together has exactly one runtime
dependency of its own — `@napi-rs/keyring`, for OS-keychain session storage.
Its welcome screen, spinners, and `init` flow are hand-rolled against
`node:*` only, matching `align` and `sign`'s zero-dependency convention.

## On-chain staking (Sepolia testnet)

`AgentStake.sol` is deployed on **Sepolia** — a public Ethereum *test*
network — at `0x64b332A1F3c01a58430E533666A80Ac22d0A15BF`. Verified live
while writing this README with a direct `eth_getCode` call against a public
Sepolia RPC: real contract bytecode is present at that address today. [View
on Sepolia
Etherscan](https://sepolia.etherscan.io/address/0x64b332A1F3c01a58430E533666A80Ac22d0A15BF).

**Sepolia ETH is testnet currency with no monetary value.** Nothing staked
or slashed against this contract puts real funds at risk.

The contract does not verify signatures or run any of `align`'s checking
logic itself — it can't; the EVM has no ed25519 precompile. It is a ledger:
it holds a stake keyed by an EVM address and lets one designated **arbiter**
address slash it when told a specific claim was proven false off-chain by
`align`. **Single-arbiter enforcement is a stated, deliberate limitation**
for this build, not an oversight — see `packages/stake/README.md`'s trust-
boundary section for the full argument and what a multi-arbiter version
would need.

## Configuration

All configuration lives in a repo-root `.env` (gitignored — copy
`.env.example` to start, or let `quorum init` do it for you):

- **Provider keys** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`,
  `CEREBRAS_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`,
  `OPENROUTER_API_KEY`. Every one is optional; `quorum campaign` and
  `quorum run` skip a provider cleanly when its key is absent instead of
  failing the whole run.
- **`WEB_ORIGIN`** — base URL of the QUORUM web app that `login`/`logout`/
  `whoami` talk to. Defaults to `http://localhost:3000`.
- **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`** — optional, paired. When
  both are set, `quorum run` mirrors its ledger events to Supabase so the
  live dashboard (companion `kevin_frontend` repo) shows real data instead
  of sample data. Leave unset to run with the local ledger only — never an
  error.

## Testing

```bash
node bin/quorum.js test
```

Runs every package's suite and prints a PASS/FAIL summary. Current result,
verified in a fresh worktree while writing this README:

```
  OK   align      PASS   151/151
  OK   sign       PASS   11/11
  OK   registry   PASS   76/76
  OK   stake      PASS   31/31
  OK   dispatch   PASS   144/145
--------------------------------------------------
ALL PACKAGES PASS  (413/414 tests)
```

The one non-passing `dispatch` count is a **skip**, not a failure — exit
code is 0 and `dispatch`'s own summary reports `fail 0`. It's a live
integration test (`ledger/supabase-store.test.js`) that skips itself
cleanly when `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` aren't set, exactly
like the rest of this CLI's Supabase-optional design.

There's also a CLI-layer suite (`npm run test:cli` — session storage, the
`quorum run` exit-code contract, terminal UI rendering) not folded into the
number above: **20/20 passing**, also verified fresh.

A GitHub Actions workflow (`.github/workflows/ci.yml`) runs `npm ci` +
`node bin/quorum.js test` on every push and pull request to `main`.

## Deployment

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full first-deploy guide: the
real cross-repo Supabase migration order (8 files, this repo's 4 first —
reversing it fails outright), every environment variable this CLI actually
reads, the `npm publish --dry-run` audit referenced above, and the
`quorum run` exit-code contract.

## Known limitations

Stated plainly, not buried — see `DEPLOYMENT.md` for the full detail behind
each:

- **The local ledger write has no error handling.** Under a real global npm
  install where the package directory isn't user-writable, `quorum run` can
  crash mid-run, after provider calls have already been made and billed.
  Not yet fixed; sized honestly in `DEPLOYMENT.md`.
- **No `files` field / `.npmignore` yet.** A real `npm publish --dry-run`
  packs 154 files including internal planning docs — bloated, not broken.
- **Single-arbiter staking**, by design for this build — see "On-chain
  staking" above.
- **`packages/stake`'s tests emit a Node `DEP0190` deprecation warning**
  (`npx hardhat test` is spawned with `shell: true`, needed on Windows to
  resolve `npx.cmd`) — cosmetic, does not affect the pass/fail result.
- The companion frontend's `/dashboard` routes have no auth gate by design;
  see that repo's own README/`DEPLOYMENT.md` for the full finding.

## Further reading

- [`PROJECT-REFERENCE.md`](PROJECT-REFERENCE.md) — the complete architecture and project history.
- [`BUILD-PLAN.md`](BUILD-PLAN.md) — where the build currently stands.
- [`DEPLOYMENT.md`](DEPLOYMENT.md) — first-deploy guide for this repo.
- [`packages/stake/README.md`](packages/stake/README.md) — the on-chain trust boundary, in full.

## License

[MIT](LICENSE) © 2026 Team 14 — HOOKPRINT.
