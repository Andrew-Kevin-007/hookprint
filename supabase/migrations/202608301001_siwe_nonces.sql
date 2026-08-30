-- 202608301001_siwe_nonces.sql
--
-- One-time nonces for Sign-In-With-Ethereum challenges. A nonce is minted
-- server-side, embedded in the SIWE message the wallet signs, and must be
-- marked consumed the moment it is redeemed -- this is what stops a
-- captured signature from being replayed to open a second session.

create table if not exists siwe_nonces (
  nonce text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed boolean not null default false
);

-- Default-deny RLS -- see supabase/migrations/README.md for the rationale.
alter table siwe_nonces enable row level security;
