-- 202608301003_identity_registry.sql
--
-- The durable twin of packages/stake/policy/identity-registry.js's
-- in-memory Map: the binding from an agent's ed25519 keyId (packages/sign's
-- keyIdOf()) to the real EVM address its stake lives under. See
-- packages/stake/policy/identity-registry-supabase.js for the Node client
-- that reads/writes this table -- key_id is the same string that module
-- validates and stores, evm_address the same 0x+40-hex shape
-- identity-registry.js's own regex enforces in-memory.

create table if not exists identity_registry (
  key_id text primary key,
  evm_address text not null check (evm_address ~ '^0x[0-9a-fA-F]{40}$'),
  registered_by text references profiles(wallet_address),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Default-deny RLS -- see supabase/migrations/README.md for the rationale.
alter table identity_registry enable row level security;
