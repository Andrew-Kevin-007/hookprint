# Deploying / distributing QUORUM (backend + CLI)

Written 2026-08-31. This repo (`D:\Tenori_Hack`) is npm workspaces: the
`quorum` CLI (`bin/quorum.js`) plus `packages/align|sign|registry|stake|
dispatch`. There is nothing here to "deploy" in the server sense — it is a
CLI tool people install and a smart contract already on Sepolia testnet.
The two real distribution questions are **"how does a real user get the
CLI"** and **"what Supabase/contract state does it depend on."** The
companion Next.js app (separate repo, `kevin_frontend`) has its own
`DEPLOYMENT.md` for the actual web deploy; this document covers this
repo's half and is the source of truth for the CLI's own behavior.

Every claim below was checked against the real code, a real
`npm publish --dry-run`, and a real `node bin/quorum.js test` run in a
fresh `git worktree` — file:line citations are given throughout.

## Prerequisites

- Node >=20 (`package.json`'s own `engines` field).
- At least one provider API key to run anything live (`quorum run`,
  `quorum campaign`) — see the table below. Every provider is optional and
  independently gated; the CLI runs fine with just one.
- Optional: a Supabase project, shared with the frontend repo, if you want
  `quorum run`'s ledger mirrored to the live `/dashboard` (see that repo's
  `DEPLOYMENT.md` for the full 8-migration order across both repos).
- Optional: a funded Sepolia testnet wallet, only if you are redeploying
  `AgentStake.sol` yourself rather than using the existing deployment (see
  "The deployed contract" below).

## Environment variables

`.env.example` (repo root) already lists every one of these — verified by
grepping `process.env` across `bin/`, `packages/`, and `packages/stake/`
directly; nothing in it is aspirational and nothing found by the grep was
missing from it.

| Variable | Required? | What breaks without it |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GROQ_API_KEY` / `CEREBRAS_API_KEY` / `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) / `OPENROUTER_API_KEY` | At least one | `quorum run` / `quorum campaign` print "no provider credentials found" and stop cleanly (`bin/quorum.js`'s `findAvailableProviders()` gate) rather than erroring |
| `WEB_ORIGIN` | No (defaults to `http://localhost:3000`) | `quorum login/logout/whoami` (`bin/lib/auth.js:26`) talk to the wrong host — see "the one real trap for real users" below |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | No, paired | Without both, `quorum run` logs "Supabase mirror disabled" and works with the local `.quorum/run-ledger.jsonl` ledger only — never an error |
| `SEPOLIA_PRIVATE_KEY` (packages/stake/.env.example) | Only for `npm run deploy:sepolia` | Deploying a **new** `AgentStake` yourself; not needed to use the existing deployment |
| `SEPOLIA_RPC_URL` / `ETHERSCAN_API_KEY` | No | Public RPC default works; Etherscan key only needed for `hardhat verify` |

### The one real trap for real users: `WEB_ORIGIN`'s dev-friendly default becomes actively wrong once distributed

`bin/lib/auth.js:26` defaults `WEB_ORIGIN` to `http://localhost:3000` —
correct today, because the only way to run this CLI is `npm link` against a
local monorepo checkout next to a locally-running frontend. **The moment
this CLI is published and installed by someone who is not also running the
frontend locally, that default is simply wrong** — `quorum login` will try
to reach a `localhost:3000` that does not exist on their machine, fail with
a clear `ECONNREFUSED` message (not a crash — `describeFetchError()`
handles it), but every real user will need to be told, out of band, to set
`WEB_ORIGIN` to wherever the frontend is actually deployed. Recommendation:
once the frontend has a stable production URL, change this default to that
URL (keep `http://localhost:3000` as an override for contributors running
both repos locally) — a one-line change, deliberately not made here since
the real production URL is not yet fixed at the time of this audit.

## Supabase migrations owned by this repo

`supabase/migrations/` here holds the **base schema** — `profiles`,
`sessions`, `siwe_nonces`, `cli_login_requests`, `identity_registry` — that
both this CLI and the frontend depend on. Full cross-repo order (8 files,
this repo's 4 first) is in the frontend repo's `DEPLOYMENT.md`; this
repo's own `supabase/migrations/README.md` explains why they're
hand-applied (no Supabase CLI/MCP available in this environment) and why
every table is default-deny RLS. Nothing to add here beyond: **if you are
setting up Supabase for the first time, start with this repo's 4 files,
then the frontend repo's 4** — reversing the order fails outright, since
the frontend's migrations `alter table` tables only these files create.

## The deployed contract — a real gap, not a config value

The task that produced this audit states the real, already-deployed
address: `AgentStake` is live on Sepolia at
`0x64b332A1F3c01a58430E533666A80Ac22d0A15BF`. **This audit could not find
that address, or any reference to it, anywhere in this repository** —
grepped the full tree (excluding `node_modules`) for the literal string and
for any `*CONTRACT_ADDRESS*`-shaped env var or constant; both came back
empty. Traced why: `scripts/deploy.js` prints the freshly deployed address
to the console (`` `AgentStake deployed at: ${address}` ``, plus an
Etherscan link when the network is `sepolia`) but **never writes it to a
file** — no deployment-record JSON, no `.env` auto-population. `packages/
stake/client/index.js`'s `getStake()`/`slash()` helpers take an
already-constructed `ethers` `Contract` object as a parameter — the caller
supplies the address; nothing in this repo reads one from an env var.
`demo-local.js`/`demo-policy.js` sidestep this entirely by deploying a
**fresh, ephemeral** contract on a local Hardhat chain every run, so they
never needed to reference the real Sepolia one.

**Net effect: the real Sepolia deployment and this repo's code are
currently unwired.** Anyone who wants a script here to act against the
*actual* deployed contract (rather than a fresh local one) has no way to
discover its address from the repo — they would need to be told it out of
band, exactly as this audit was. Recommended fix, not made here because it
is a real design choice (a single hardcoded constant vs. an env var vs. a
small per-network JSON registry, and which scripts should read it):
persist the address `scripts/deploy.js` already prints — at minimum, add
`AGENT_STAKE_CONTRACT_ADDRESS` to `.env.example`/`packages/stake/
.env.example` with the real Sepolia address as a comment, and have the
scripts that need a live contract instance read it as a fallback default.

## `quorum run`'s exit code contract — new, and worth scripting against correctly

As of commit `a78785a` (merged into this branch), `quorum run` exits
**non-zero** when its result is untrustworthy, not just on a usage error.
Before that fix, `quorum run` always exited 0 once it started executing —
found by deliberately forcing every provider to fail auth, not by reading
code, per that commit's own message; a CI job doing `quorum run && deploy`
would have treated a total pipeline failure as a pass.

The rule, from `bin/quorum.js`'s `cmdRun()` (around line 630):

```js
const untrustworthy =
  mergeResult.status !== 'CLEAN' ||
  mergeResult.failedBatches.length > 0 ||
  verified !== true;

if (untrustworthy) {
  process.exitCode = 1;
}
```

Concretely, exit codes for `quorum run`:

| Condition | Exit code |
|---|---|
| Merge status `CLEAN`, zero failed batches, `verifyExecutionTrace()` true | `0` |
| Merge status `CONTRADICTIONS_FOUND` | `1` — **deliberately a failure, not a warning.** Catching a real cross-batch disagreement is the product working as intended, but the answer it just produced is exactly the kind that must not ship unreviewed. A script that greps stdout for "contradiction" and otherwise trusts exit 0 will miss this. |
| Merge status `INCOMPLETE` (a batch never produced a usable result) | `1` |
| Any batch in `failedBatches` | `1`, even if the overall merge status somehow reads otherwise |
| `verifyExecutionTrace()` returns `false` | `1` — the signed record of what happened cannot be trusted, independent of what the merge concluded |
| Usage error (no task arg) | `1` (pre-existing, unchanged) |

**If you script `quorum run` in CI or a pipeline: check the real exit code,
not just stdout.** `CONTRADICTIONS_FOUND` in particular is easy to
misclassify as "ran fine, found something interesting" if you are only
watching for a crash.

## CLI distribution — what `npm publish` would actually require

Checked with a real `npm publish --dry-run`, not assumed. Three real
blockers found; two fixed in this pass, one left as a deliberate decision
for Kevin, plus one architectural gap that survives even after everything
else is fixed.

### Fixed in this pass

1. **No `"version"` field.** `package.json` had none at all. A real
   `npm publish --dry-run` crashed outright:
   `TypeError: Cannot read properties of null (reading 'prerelease')`
   (`npm@11.7.0`, reproduced directly). Added `"version": "0.1.0"`; the
   dry-run now proceeds to produce a real, valid tarball listing.
2. **`bin` path had a redundant `"./"` prefix.** `"quorum": "./bin/
   quorum.js"` triggered an npm publish warning reading "was invalid and
   removed" — alarming wording, but traced into the actual npm source
   (`@npmcli/package-json/lib/normalize.js`) and confirmed it is purely
   cosmetic: npm normalizes the **string value** (strips the `"./"`) and
   keeps the bin entry fully intact either way; nothing is actually
   dropped. Fixed anyway (`"quorum": "bin/quorum.js"`) since it removes a
   confusing warning for zero cost, and re-ran the dry-run to confirm the
   warning is gone.
3. Also set the git-tracked file mode for `bin/quorum.js` to `100755` (it
   was `100644` — the file has a `#!/usr/bin/env node` shebang but was
   authored on Windows, where the bit is meaningless locally, so it was
   never set). This does not fix a reproduced bug — npm's own `bin-links`
   step chmods scripts executable at install time on POSIX regardless of
   the source repo's tracked bit — but it is more correct for a real POSIX
   checkout and cost nothing to fix.

### Deliberately NOT fixed — Kevin's call

4. **`"private": true` is still set**, and is correctly what stops an
   accidental `npm publish` today. Removing it is the actual "make this
   public" decision, not a bug to patch during an audit — left untouched.
5. **The package name `quorum` is already taken on the public npm
   registry.** Verified directly: `npm view quorum` returns a real,
   published `quorum@0.0.0-1` (a different, unrelated package, by a
   different maintainer, over a year old). **Publishing under this exact
   name is not possible.** Kevin needs to pick either a scoped name (e.g.
   `@<your-npm-username>/quorum`) or a different unscoped name before a
   real publish — not something this audit should decide unilaterally.

### Not fixed — a real architectural gap, sized honestly

6. **`ROOT` is resolved from the CLI's own install location, not the
   user's environment** — `` const ROOT = join(dirname(fileURLToPath(
   import.meta.url)), '..') `` (`bin/quorum.js:33`). This is fine for
   today's only real usage pattern (`npm link` against a cloned monorepo),
   but breaks two things once this is a real globally-installed or
   `npx`-invoked package:

   - **`.env` auto-loading** (`bin/quorum.js:46-48`,
     `` join(ROOT, '.env') ``): a real user's `.env` living next to
     wherever *they* run `quorum` from is never found — `ROOT` points
     inside the npm package install directory instead. This is a soft
     failure, not a hard one: `process.loadEnvFile()` just silently does
     nothing when the file is absent, and any credential a user actually
     `export`s in their shell still reaches `process.env` normally. So
     real users are NOT locked out — they lose a dev convenience
     (drop a `.env` file next to your project) that a distributed CLI
     never gave them in the first place.

   - **The local ledger, and this one is a real crash risk, not just an
     inconvenience.** `quorum run` writes to
     `` join(ROOT, '.quorum', 'run-ledger.jsonl') `` (`bin/quorum.js:423`).
     Under a global npm install, `ROOT` is the package's install
     directory — on many systems (a `sudo npm install -g`, or a
     system-managed Node install) that directory is not writable by a
     normal user. `appendEvent()` (`packages/dispatch/ledger/store.js:
     46-61`) calls `mkdirSync`/`appendFileSync` with **no try/catch**, and
     `bin/quorum.js:430` calls it directly with no try/catch around the
     call either (only the *optional Supabase mirror* write, immediately
     below it, is wrapped in one). **A permissions failure here crashes
     `quorum run` outright**, mid-run, after real provider API calls have
     already been made and billed. Reproduced by reading the exact code
     path, not by simulating a locked-down global install in this
     environment.

   Recommended fix (not implemented here — this is a real design decision
   about where a CLI's user-state lives, not a one-line patch):
   `bin/lib/auth.js` already solved exactly this problem for session
   storage (`sessionFilePath()`, using `%LOCALAPPDATA%\quorum` on Windows
   and `~/.quorum` elsewhere) — extend that same pattern to the run-ledger
   and the `.env` fallback, falling back to `process.cwd()`-relative paths
   only when explicitly requested (e.g. for contributors running from a
   monorepo checkout).

### Also worth doing before a real publish, not done here

7. **No `files` field or `.npmignore`.** A real `npm publish --dry-run`
   (after the version fix) packed **154 files, 570.4 kB compressed / 2.1 MB
   unpacked** — including internal planning docs never needed at runtime
   (`BUILD-PLAN.md` 32.7 kB, `CONTENT-BRIEF.md` 37.4 kB, `LOKI-ATTACK.md`
   36.6 kB, `PROJECT-REFERENCE.md` 40.6 kB, all of `docs/archive/`, and the
   `fixtures/real-corpus/` benchmark corpus). Not broken — just bloated and
   unprofessional for a real published package. Not curated here because
   getting a `files` allowlist wrong (accidentally excluding something
   `packages/*` or `bench/*` actually needs at runtime) would ship a
   silent regression; this needs its own deliberate pass, not one folded
   into a deployment audit.

## Known limitations before real users

- **The ledger-write crash above** (point 6) is the most likely to actually
  hurt a real distributed user, and is the top item to fix before
  publishing for real.
- **`/dashboard` and `/dashboard/run/[taskId]` in the frontend repo have no
  auth gate** — every user's run traces become publicly readable the
  moment real users start running tasks through a deployed frontend. Not
  this repo's code; full finding in the frontend repo's `DEPLOYMENT.md`.
- **No CI existed for this repo before this pass.** Added a minimal
  `.github/workflows/ci.yml` (`npm ci` + `node bin/quorum.js test`) — it
  does not touch Supabase, Sepolia, or any live provider key, so it cannot
  catch a live-integration regression, only a broken install/test run.
- **`packages/stake` test output emits a Node `DEP0190` deprecation
  warning** (`npx hardhat test` is spawned with `shell: true`, needed on
  Windows because `npx` resolves to `npx.cmd`) — harmless today, worth a
  look if this ever moves to a `shell:false`-safe invocation.

## Verification performed for this document (2026-08-31)

- `npm install` in a fresh worktree (`.claude/worktrees/deployment-
  readiness`, branched from `main` and merged forward to `a78785a`): 717
  packages, exit 0.
- `node bin/quorum.js test`: **413/414**, unchanged before and after this
  pass's `package.json` fixes and the merge from `main`
  (align 151/151, sign 11/11, registry 76/76, stake 31/31, dispatch
  144/145 — the one pre-existing skip is unrelated to this work).
- `npm publish --dry-run`, twice: once showing the real version-field crash,
  once clean after the fix, producing a real tarball listing (154 files,
  570.4 kB / 2.1 MB).
- `git ls-files -s bin/quorum.js` before and after `git update-index
  --chmod=+x`, confirming `100644` -> `100755`.
- `npm view quorum` against the real public registry, confirming the name
  collision.
- Traced `@npmcli/package-json/lib/normalize.js` in the actual installed
  npm CLI to confirm the bin-path warning is cosmetic rather than a real
  loss of the bin entry — did not trust the warning's own wording.
- Grepped the full repository tree for the literal deployed contract
  address and for any `*CONTRACT_ADDRESS*` pattern; both came back empty,
  confirmed by reading `scripts/deploy.js` and `packages/stake/client/
  index.js` directly rather than concluding from the grep alone.
- Every `process.env.*` reference in `bin/`, `packages/` (excluding
  `node_modules`) grepped directly; cross-checked against `.env.example`
  and `packages/stake/.env.example` — nothing missing.
- `git ls-files | grep env` in this repo: only the two `.env.example`
  files (no real secrets ever committed).
