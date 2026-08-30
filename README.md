# QUORUM

A trust-aware AI execution router. It profiles a task, routes it to whichever
provider actually earns the work, executes it, merges the results, scores
their quality, and signs the whole execution trace — so a multi-provider run
is verifiable after the fact, not just hoped to have gone well.

Built for **Tenori Hack**, Track 02 (Agentic Web, Swarms & Harnesses). See
`PROJECT-REFERENCE.md` for the full architecture and `BUILD-PLAN.md` for
where the build currently stands — this file is just the CLI.

## Install

### Local development (this repo)

```
npm install
npm link
```

`npm link` puts a global `quorum` command on your PATH, backed by
`bin/quorum.js` in this checkout — edits to the source take effect
immediately, no reinstall needed. Requires Node 20+ (this project runs Node
24; see `package.json`'s `engines` field).

### Once published

QUORUM isn't on the npm registry yet. When it is, the equivalent install is:

```
npm install -g quorum
```

### First run

```
quorum init
```

Interactive first-run setup: creates `.env` from `.env.example` if it
doesn't exist yet, prompts for any provider API key you don't already have
set (an empty answer skips that provider — you don't need all of them), and
offers to log in. Safe to run again any time; it only asks about what's
still missing. Piped or non-interactive input (no TTY) makes it print what's
missing and exit instead of hanging on a prompt that will never come.

Run bare `quorum` any time afterward for a status check — which providers
are configured, whether the Supabase dashboard mirror is on, whether you're
logged in — plus a next-step nudge.

## Commands

| Command | What it does |
|---|---|
| `quorum` | Welcome screen: real configured/missing status at a glance, and what to run next. |
| `quorum init` | First-run setup — create `.env`, prompt for missing provider keys, offer to log in. |
| `quorum test` | Run every package's test suite (align, sign, registry, stake, dispatch) and print PASS/FAIL per package plus a total. No network calls, no API keys required. |
| `quorum bench [--raw]` | Run the real corruption benchmark (`bench/run.js`) against the labelled corpus; prints precision/recall/false-positive rate. |
| `quorum campaign` | Run the Phase 3 degradation-measurement campaign (`bench/degradation/`) for real, against every provider with a credential env var present. Providers with no key are skipped, not fatal. |
| `quorum run "<task>"` / `quorum run --file <path>` | Run one real task through the full dispatch pipeline (intake → profile → route → execute → merge → score → sign → verify) against whichever providers actually have credentials in `.env`. Writes a local ledger (`.quorum/run-ledger.jsonl`) and, if Supabase is configured, mirrors it to the live dashboard. |
| `quorum login` | Log in via the browser (opens the web app's login page, polls for approval, stores a session locally). |
| `quorum logout` | Revoke and clear the locally stored session. |
| `quorum whoami` | Print the wallet address of the current session, or that you're logged out. |
| `quorum --help` / `quorum help` | Show the full command list. |

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
- **`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`** — optional. When both are
  set, `quorum run` mirrors its ledger events to Supabase so the live
  dashboard shows real data instead of sample data. Leave unset to run with
  the local ledger only.

## Development

This is an npm workspaces monorepo (`packages/*`), ESM throughout
(`"type": "module"`). Per-package test scripts exist in `package.json`
(`npm run test:align`, `test:sign`, `test:registry`, `test:stake`,
`test:dispatch`, `test:cli`), or run everything at once via `quorum test` /
`npm test`. The CLI itself has exactly one runtime dependency
(`@napi-rs/keyring`, for OS-keychain session storage) — its welcome screen,
spinners, and `init` flow are hand-rolled against `node:*` only, matching
`packages/align` and `packages/sign`'s zero-dependency convention.
