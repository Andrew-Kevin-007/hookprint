-- 202608301000_profiles_and_sessions.sql
--
-- profiles: one row per wallet that has ever authenticated. wallet_address
-- is the primary key (not a surrogate id) since a wallet IS the identity in
-- this system -- there is no separate account concept above it.
--
-- sessions: server-issued session tokens, one row per login (web or CLI).
-- The real bearer token is never stored -- only a hash of it
-- (session_token_hash), same discipline a password table would use, so a
-- read of this table alone can never be replayed as a live session.

create table if not exists profiles (
  wallet_address text primary key check (wallet_address ~ '^0x[0-9a-fA-F]{40}$'),
  display_name text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists sessions (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null references profiles(wallet_address) on delete cascade,
  session_token_hash text not null unique,
  client text not null check (client in ('web', 'cli')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create index if not exists sessions_wallet_address_idx on sessions(wallet_address);

-- Default-deny RLS -- see supabase/migrations/README.md for the rationale.
-- No policies are added for anon/authenticated: every real read or write
-- goes through the service-role key, server-side, which bypasses RLS by
-- Supabase's own design.
alter table profiles enable row level security;
alter table sessions enable row level security;
