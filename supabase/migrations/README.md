# supabase/migrations

Plain `.sql` files, one concern per file, named `<YYYYMMDDHHMM>_<name>.sql` so
filename order is chronological order.

## How to apply these

There is no local Supabase CLI or MCP server available in this environment,
so these are **not** wired to `supabase db push` or any migration runner.
Apply them manually, in filename order, via **Supabase Studio's SQL editor**
(Project → SQL Editor → paste the file's contents → Run) against whichever
Supabase project backs this deployment. Each file is idempotent
(`create table if not exists`), so re-running one against a project that
already has it is a no-op, not an error.

Current files, in the order to run them:

1. `202608301000_profiles_and_sessions.sql` — `profiles`, `sessions`
2. `202608301001_siwe_nonces.sql` — `siwe_nonces`
3. `202608301002_cli_login_requests.sql` — `cli_login_requests`
4. `202608301003_identity_registry.sql` — `identity_registry` (the durable
   twin of `packages/stake/policy/identity-registry.js`'s in-memory `Map`)

## Why every table is RLS-enabled with zero policies (default-deny)

Every table here gets `alter table X enable row level security;` and,
deliberately, **no** `create policy` statements for the `anon` or
`authenticated` roles. With RLS on and no policies, every request through
Supabase's public (anon/authenticated) API is denied by default — reads and
writes included.

This is intentional, not an oversight to fill in later. All real access to
these tables happens **server-side**, through the Supabase **service-role
key** (see `packages/stake/policy/identity-registry-supabase.js`), which
bypasses RLS entirely by Supabase's own design. Nothing in this system's
current design lets a browser or CLI talk to these tables directly — every
read and write is mediated by server code that already knows what it's
allowed to do.

Given that, the alternative — writing `anon`/`authenticated` policies that
carefully scope access per row — would add a whole class of risk
(RLS-misconfiguration: a policy that's subtly too permissive, or a `USING`
clause that doesn't cover an edge case) in exchange for a capability nothing
in this system actually needs yet. Default-deny removes that risk class
entirely rather than trying to get it right. If a future feature needs
direct client access to one of these tables, add the specific policy that
feature needs at that point, reviewed on its own — don't pre-emptively open
the tables now on the chance it's needed later.
