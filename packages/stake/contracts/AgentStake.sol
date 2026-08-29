// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * AgentStake — the on-chain enforcement half of BATON's staking story.
 *
 * WHAT THIS CONTRACT IS NOT: it does not verify an ed25519 signature (the EVM
 * only has secp256k1 precompiles; BATON agent identities are ed25519 keyIds
 * from packages/sign) and it does not run BATON's alignment/diff checker. It
 * cannot tell you whether any claim is true or false.
 *
 * WHAT IT IS: a ledger that holds a stake keyed by a normal EVM address (NOT
 * an agent's ed25519 key — those never touch chain), and a single function,
 * `slash`, that only one address — the arbiter — may call to move funds out
 * of a losing agent's stake when told (off-chain) that a specific claim was
 * proven false.
 *
 * THE TRUST BOUNDARY, STATED EXPLICITLY (see CONTENT-BRIEF.md §0/§0.2 and
 * BUILD-PLAN.md's "known attacks" table):
 *   - The VERDICT ("this claim is false") is produced off-chain, by BATON's
 *     deterministic checker (packages/align + packages/sign) — no LLM, no
 *     network, fully reproducible.
 *   - The ENFORCEMENT (moving the money) happens on-chain, here.
 *   - For tonight's demo there is exactly ONE arbiter: the contract deployer,
 *     standing in for "the BATON checker's verdict got relayed on-chain."
 *     That is a single point of trust/failure by design, not an oversight —
 *     multi-arbiter / decentralized enforcement is named future work
 *     (CONTENT-BRIEF.md §0.2), not tonight's job. A production version would
 *     replace `arbiter` with a quorum, an oracle network, or a dispute game;
 *     none of that is built here.
 *
 * Slashed funds are sent to the arbiter address — a stand-in for "the party
 * that proved the claim false gets made whole." A production version might
 * route to a claimant-specified address, a public goods pool, or burn
 * entirely; for a hackathon demo, "goes to whoever holds the arbiter role"
 * is the simplest rule that is still auditable on-chain.
 */
contract AgentStake {
    struct Stake {
        uint256 amount;
        bool active;
    }

    mapping(address => Stake) public stakes;

    /// Demo arbiter — the deployer. Named limitation: single arbiter, not
    /// decentralized. See the contract-level comment above.
    address public immutable arbiter;

    /// Reentrancy guard state for unstake's external call (checks-effects-
    /// interactions is already followed there; this is defense in depth).
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private reentrancyStatus = NOT_ENTERED;

    event Staked(address indexed agent, uint256 amount, uint256 newTotal);
    event Slashed(address indexed agent, uint256 amount, uint256 remaining, string claimId, string reasonClass);
    event Unstaked(address indexed agent, uint256 amount, uint256 remaining);

    modifier onlyArbiter() {
        require(msg.sender == arbiter, 'AgentStake: only arbiter');
        _;
    }

    modifier nonReentrant() {
        require(reentrancyStatus != ENTERED, 'AgentStake: reentrant call');
        reentrancyStatus = ENTERED;
        _;
        reentrancyStatus = NOT_ENTERED;
    }

    constructor() {
        arbiter = msg.sender;
    }

    /// Lock ETH as an agent's stake. Callable by anyone, on their own behalf —
    /// there is no on-chain notion of *which* ed25519 keyId an address speaks
    /// for; that binding is an off-chain fact BATON's checker or a registry
    /// would need to attest separately (not built tonight).
    function stake() external payable {
        require(msg.value > 0, 'AgentStake: stake must be > 0');
        Stake storage s = stakes[msg.sender];
        s.amount += msg.value;
        s.active = true;
        emit Staked(msg.sender, msg.value, s.amount);
    }

    /// Arbiter-only. Moves `amount` out of `agent`'s stake and to the arbiter,
    /// tagged with the claim and corruption class that justified it. `claimId`
    /// and `reasonClass` are opaque strings on-chain — their meaning (a BATON
    /// claim id like "c_014", a reasonClass like "denominator_loss") is
    /// entirely an off-chain convention this contract does not interpret.
    function slash(address agent, uint256 amount, string calldata claimId, string calldata reasonClass) external onlyArbiter {
        require(amount > 0, 'AgentStake: slash amount must be > 0');
        Stake storage s = stakes[agent];
        require(s.amount >= amount, 'AgentStake: insufficient stake');

        s.amount -= amount;
        if (s.amount == 0) {
            s.active = false;
        }
        emit Slashed(agent, amount, s.amount, claimId, reasonClass);

        // Interaction last (checks-effects-interactions). arbiter is set once
        // in the constructor and is never a contract the caller controls in
        // the demo, but nonReentrant + CEI ordering are kept anyway — see
        // unstake() for why this matters more there.
        (bool ok, ) = arbiter.call{value: amount}('');
        require(ok, 'AgentStake: transfer to arbiter failed');
    }

    /// Standard withdrawal. checks-effects-interactions: balance is reduced
    /// before the external call, and nonReentrant blocks a malicious
    /// receiving contract from re-entering mid-transfer.
    function unstake(uint256 amount) external nonReentrant {
        require(amount > 0, 'AgentStake: unstake amount must be > 0');
        Stake storage s = stakes[msg.sender];
        require(s.active, 'AgentStake: no active stake');
        require(s.amount >= amount, 'AgentStake: amount exceeds stake');

        s.amount -= amount;
        if (s.amount == 0) {
            s.active = false;
        }
        emit Unstaked(msg.sender, amount, s.amount);

        (bool ok, ) = msg.sender.call{value: amount}('');
        require(ok, 'AgentStake: transfer failed');
    }

    /// Convenience read — `stakes(address)` (the public mapping getter) already
    /// exposes this, but a named view reads better in a demo script/UI.
    function stakeOf(address agent) external view returns (uint256 amount, bool active) {
        Stake storage s = stakes[agent];
        return (s.amount, s.active);
    }
}
