/**
 * client/index.js — thin Node wrapper around AgentStake for scripts/UI
 * integration, so nothing outside this package has to know ABI details or
 * ether<->wei conversion.
 *
 * THE GAP THIS MODULE PAPERS OVER, STATED EXPLICITLY (see contracts/AgentStake.sol
 * and CONTENT-BRIEF.md §0.2): packages/align's Delta objects identify a claim
 * by `claimId` (a BATON-internal id like "c_014") and a `class` (one of the
 * four frozen corruption classes). They carry no EVM address and no bonded
 * amount — BATON's off-chain contract has no concept of money. Turning a
 * Delta into a slash() call requires two facts a Delta does NOT contain:
 *   1. which EVM address the responsible agent's stake lives under, and
 *   2. how much to slash.
 * Tonight that mapping is supplied by the caller (see fixtures/reject-verdict.json
 * and scripts/demo-local.js) rather than derived automatically — a real
 * integration would need an agent-identity registry (ed25519 keyId -> EVM
 * address) and a slashing policy (how much, by corruption class/severity).
 * Both are named, not built — same discipline as the rest of BATON's "what's
 * next" list.
 */

function deltaToSlashInput(delta) {
  if (!delta || typeof delta !== 'object') {
    throw new Error('deltaToSlashInput: expected a Delta-shaped object');
  }
  const { class: reasonClass, claimId, agent, amountEth } = delta;
  if (typeof reasonClass !== 'string' || !reasonClass) {
    throw new Error('deltaToSlashInput: delta.class is required (becomes reasonClass on-chain)');
  }
  if (typeof claimId !== 'string' || !claimId) {
    throw new Error('deltaToSlashInput: delta.claimId is required');
  }
  if (typeof agent !== 'string' || !agent) {
    throw new Error(
      'deltaToSlashInput: delta.agent (an EVM address) is required — a real Delta carries no EVM address; ' +
        'see the module header comment for the registry gap this papers over'
    );
  }
  if (amountEth === undefined || amountEth === null || amountEth === '') {
    throw new Error('deltaToSlashInput: delta.amountEth is required — a real Delta carries no bonded amount');
  }
  return { agent, amountEth: String(amountEth), claimId, reasonClass };
}

/** Read the current stake for an address. Returns { amountEth, amountWei, active }. */
async function getStake(contract, ethers, address) {
  const [amount, active] = await contract.stakeOf(address);
  return { amountWei: amount, amountEth: ethers.formatEther(amount), active };
}

/** Stake `amountEth` ETH from `signer`. Returns the mined tx receipt. */
async function stakeAs(contract, ethers, signer, amountEth) {
  const tx = await contract.connect(signer).stake({ value: ethers.parseEther(String(amountEth)) });
  return tx.wait();
}

/**
 * Slash `input.agent` for `input.amountEth`, tagged with `input.claimId` /
 * `input.reasonClass`. `input` is the shape produced by `deltaToSlashInput`
 * (or constructed directly with the same four fields). Must be called with an
 * arbiter signer or the contract reverts.
 */
async function slashFromInput(contract, ethers, arbiterSigner, input) {
  const { agent, amountEth, claimId, reasonClass } = input;
  const tx = await contract.connect(arbiterSigner).slash(agent, ethers.parseEther(String(amountEth)), claimId, reasonClass);
  return tx.wait();
}

module.exports = { deltaToSlashInput, getStake, stakeAs, slashFromInput };
