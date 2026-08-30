-- 202608301002_cli_login_requests.sql
--
-- Backs a device-code-style CLI login: the CLI creates a pending request
-- (request_id, state), a human approves it in the browser against their
-- wallet, and the CLI exchanges exchange_code_hash for a real session once
-- status flips to 'approved'/'consumed'. Nothing sensitive is stored in the
-- clear -- exchange_code_hash and session_token_hash are hashes, same
-- convention as the sessions table.

create table if not exists cli_login_requests (
  request_id text primary key,
  state text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'consumed', 'expired')),
  wallet_address text references profiles(wallet_address),
  exchange_code_hash text,
  session_token_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Default-deny RLS -- see supabase/migrations/README.md for the rationale.
alter table cli_login_requests enable row level security;
