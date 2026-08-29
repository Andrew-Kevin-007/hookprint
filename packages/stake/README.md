# `@baton/stake`

The on-chain enforcement half of BATON's staking story. See `CONTENT-BRIEF.md`
§0 / §0.2 and `BUILD-PLAN.md`'s "known attacks" table for the full argument;
summarized here.

## The trust boundary — read this before the contract

A signature (`packages/sign`) proves *who* said something, not whether it was
*true*. `packages/align`'s deterministic checker is the authority on whether a
claim was corrupted in a handoff — it verifies the ed25519 attestation and
runs the four-class diff, entirely off-chain, no network, no LLM.

**`AgentStake.sol` does not verify anything.** It cannot check an ed25519
signature (the EVM only has secp256k1 precompiles) and it does not run
BATON's checker. It is a ledger: it holds a stake keyed by a normal EVM
address (never an agent's ed25519 key — that never touches chain), and lets
one designated address — the **arbiter** — slash that stake when told a
specific claim was proven false off-chain.

For tonight's demo the arbiter is the contract deployer, standing in for "the
BATON checker's verdict got relayed on-chain." **Single arbiter, not
decentralized — a named limitation, not an oversight.** Multi-arbiter /
decentralized enforcement, key rotation, and cross-org trust are named future
work (`CONTENT-BRIEF.md` §0.2), not built here.

Slashed funds go to the arbiter address — a stand-in for "the party that
proved the claim false is made whole." A production version might route to a
claimant-specified address or a public-goods pool instead; either is a policy
change, not a contract redesign.

## Layout

```
contracts/AgentStake.sol   the contract
test/AgentStake.test.js    13 tests (stake, slash, unstake, access control, reentrancy path)
client/index.js            Node wrapper: Delta -> slash() call, stake/balance helpers
scripts/demo-local.js      npm run demo:local — the on-stage sequence
scripts/deploy.js          npm run deploy:sepolia — testnet deploy
scripts/generate-wallet.js one-off: mint a fresh testnet wallet into .env
fixtures/reject-verdict.json  a REJECT-verdict-shaped input for the demo
```

## Commands

```bash
npm install
npm run compile          # hardhat compile
npm test                 # hardhat test — 13/13 green
npm run demo:local       # deploy + stake + slash on a clean ephemeral chain, real before/after balances
```

## The JSON shape the slash script expects

`packages/align`'s `gate()` produces a `Report` whose `deltas[]` are
`Delta`-shaped (frozen in `packages/align/contract.js`):

```
{ class, subtype, severity, hop, claimId, cid, message, evidence: {origin, restatement}, ... }
```

`class` is one of the four frozen corruption classes
(`value_drift` / `unit_drift` / `denominator_loss` / `caveat_loss`) and maps
directly to the contract's `reasonClass` string parameter.

**The gap:** a `Delta` identifies a *claim* (`claimId`) and a *corruption
class* — it carries no EVM address and no bonded amount, because BATON's
off-chain contract has no concept of money. Turning a `Delta` into a
`slash()` call needs two facts a `Delta` does not contain:

1. which EVM address the responsible agent's stake lives under (an
   ed25519-keyId -> EVM-address registry — not built tonight), and
2. how much to slash (a policy keyed on class/severity — not built tonight).

Tonight, both are supplied by the caller. `fixtures/reject-verdict.json` is a
real `Delta` (same fields `gate()` would emit, including its `evidence`
pointers) plus two extra fields a real integration would need a registry/
policy layer to attach:

```json
{
  "class": "denominator_loss",
  "subtype": "base_dropped",
  "severity": "fail",
  "hop": 3,
  "claimId": "c_014",
  "cid": "h3_009",
  "message": "...",
  "evidence": { "origin": { ... }, "restatement": { ... } },
  "agent": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "amountEth": "0.4"
}
```

`client/index.js`'s `deltaToSlashInput(delta)` turns that into
`{ agent, amountEth, claimId, reasonClass }` and validates all four fields are
present, throwing a clear error naming exactly which registry/policy fact is
missing if `agent` or `amountEth` isn't there — wiring the real `gate()`
output in later means producing an object with those two extra fields
attached, nothing else changes.

## Testnet (bonus, best-effort)

No funded wallet was pre-configured in this environment. `scripts/generate-wallet.js`
minted a fresh one; the private key was written straight to a local `.env`
(gitignored, never printed to a log) and never leaves this environment. Fund
it via a Sepolia faucet, then `npm run deploy:sepolia`. See the top-level
task report for the generated address and current status.
