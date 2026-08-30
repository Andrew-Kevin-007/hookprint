/**
 * scripts/demo-policy.js — proves the policy bridge (`policy/`) end-to-end
 * on a fresh local Hardhat chain: a real QUORUM quality/contradiction
 * signal in, a real `slash()` transaction out (or a real, printed refusal),
 * through `policy/index.js`'s `evaluateAndSlash()`.
 *
 * Run with `npm run demo:policy` (== `hardhat run scripts/demo-policy.js`).
 * Same one-chain-per-run model as `scripts/demo-local.js` — no separate
 * `hardhat node` process required.
 *
 * Three scenarios, in this order, on the SAME chain and the SAME two
 * agents:
 *   1. A real quality-failure batch for agent A -> a REAL slash.
 *   2. A bare contradiction between agent A and agent B, no corroboration
 *      -> NO slash, and a printed reason why not.
 *   3. THE SAME contradiction, now corroborated by a third-party agreement
 *      that backs agent A's value -> a REAL slash, against agent B only.
 */
'use strict';

const { ethers } = require('hardhat');
const { createIdentityRegistry } = require('../policy/identity-registry');
const { evaluateAndSlash } = require('../policy');

function line() {
  console.log('-'.repeat(72));
}

function section(title) {
  line();
  console.log(title);
  line();
}

async function printStake(contract, ethersLib, label, signer) {
  const [amount, active] = await contract.stakeOf(signer.address);
  console.log(`  ${label}  amount=${ethersLib.formatEther(amount)} ETH  active=${active}`);
  return amount;
}

async function main() {
  // packages/sign is an ESM package ("type": "module"); packages/stake is
  // CommonJS. A dynamic import() is the correct, standard way to consume
  // an ESM module from a CJS script -- not a workaround.
  const { generateIdentity } = await import('../../sign/index.js');

  console.log('QUORUM stake/slash policy bridge -- local chain demo');
  line();

  const [deployer, agentASigner, agentBSigner] = await ethers.getSigners();
  console.log(`arbiter (deployer): ${deployer.address}`);

  const AgentStake = await ethers.getContractFactory('AgentStake');
  const contract = await AgentStake.deploy();
  await contract.waitForDeployment();
  console.log(`AgentStake deployed at: ${await contract.getAddress()}`);
  line();

  // Two REAL ed25519 agent identities (packages/sign's generateIdentity()),
  // bound to two of Hardhat's local EVM accounts via the identity registry
  // this task built -- the bridge that does not otherwise exist anywhere in
  // this codebase.
  const agentA = generateIdentity();
  const agentB = generateIdentity();
  console.log(`agent A keyId: ${agentA.keyId}  ->  EVM ${agentASigner.address}`);
  console.log(`agent B keyId: ${agentB.keyId}  ->  EVM ${agentBSigner.address}`);
  line();

  const registry = createIdentityRegistry();
  registry.register(agentA.keyId, agentASigner.address);
  registry.register(agentB.keyId, agentBSigner.address);
  console.log('identity registry: both agents registered.');
  line();

  const STAKE_AMOUNT_ETH = '1.0';
  await contract.connect(agentASigner).stake({ value: ethers.parseEther(STAKE_AMOUNT_ETH) });
  await contract.connect(agentBSigner).stake({ value: ethers.parseEther(STAKE_AMOUNT_ETH) });
  console.log(`agent A and agent B each staked ${STAKE_AMOUNT_ETH} ETH`);

  /* ========================================================================
   * SCENARIO 1 — quality failure, agent A
   * ==================================================================== */
  section('SCENARIO 1 -- quality failure (agent A)');

  // Shaped exactly like quality/score.js's buildQualityScoreEvent() output:
  // a batch whose deterministic checks and cross-batch consistency both
  // came back badly wrong (ungrounded claims, net-contradicted by peers).
  const qualityEvent = {
    eventType: 'batch-quality-scored',
    taskId: 'demo-task-1',
    provider: agentA.keyId,
    routeId: null,
    payload: {
      batchIndex: 0,
      contextRatio: 0.72,
      deterministicScore: 0.18,
      consistencyScore: 0.15,
      combinedScore: 0.16,
      weights: { deterministic: 0.35, consistency: 0.65 },
      reasons: ['zero_claims_but_input_contains_quantifiable_content', 'answer_looks_truncated_heuristic']
    },
    timestamp: new Date().toISOString()
  };
  console.log('batch-quality-scored event (agent A):');
  console.log(JSON.stringify(qualityEvent, null, 2));
  line();

  console.log('BEFORE:');
  const beforeA1 = await printStake(contract, ethers, 'agent A', agentASigner);
  line();

  const scenario1 = await evaluateAndSlash({
    qualityScoreEvent: qualityEvent,
    verification: null,
    registry,
    contract,
    arbiterSigner: deployer,
    ethers
  });
  console.log('evaluateAndSlash() result:');
  console.log(JSON.stringify(scenario1, null, 2));
  line();

  console.log('AFTER (expect: agent A slashed):');
  const afterA1 = await printStake(contract, ethers, 'agent A', agentASigner);
  console.log(`slashed: ${ethers.formatEther(beforeA1 - afterA1)} ETH`);

  /* ========================================================================
   * SCENARIO 2 — bare contradiction, NO corroboration
   * ==================================================================== */
  section('SCENARIO 2 -- contradiction, NO corroboration (agent A vs agent B)');

  // Shaped exactly like one entry of merge/consistency.js's
  // crossCheckBatches().contradictions.
  const contradiction = {
    claimA: {
      provider: agentA.keyId,
      batchIndex: 1,
      claim: { subject: 'dispatch records that failed verification', value: 5, unit: 'percent', denominator: null }
    },
    claimB: {
      provider: agentB.keyId,
      batchIndex: 1,
      claim: { subject: 'dispatch records that failed verification', value: 60, unit: 'percent', denominator: null }
    },
    comparison: {
      relation: 'contradict',
      reason: 'agent A says 5%, agent B says 60% -- same subject, incompatible values',
      delta: 0.9167
    }
  };
  const verificationNoCorroboration = { contradictions: [contradiction], agreements: [], unmatched: [] };
  console.log('contradiction (no third-party signal in sight):');
  console.log(JSON.stringify(contradiction, null, 2));
  line();

  console.log('BEFORE:');
  const beforeA2 = await printStake(contract, ethers, 'agent A', agentASigner);
  const beforeB2 = await printStake(contract, ethers, 'agent B', agentBSigner);
  line();

  const scenario2 = await evaluateAndSlash({
    qualityScoreEvent: null,
    verification: verificationNoCorroboration,
    registry,
    contract,
    arbiterSigner: deployer,
    ethers
  });
  console.log('evaluateAndSlash() result:');
  console.log(JSON.stringify(scenario2, null, 2));
  line();

  console.log('AFTER (expect: unchanged for both -- no ground truth, no slash):');
  const afterA2 = await printStake(contract, ethers, 'agent A', agentASigner);
  const afterB2 = await printStake(contract, ethers, 'agent B', agentBSigner);
  console.log(`agent A unchanged: ${beforeA2 === afterA2}`);
  console.log(`agent B unchanged: ${beforeB2 === afterB2}`);

  /* ========================================================================
   * SCENARIO 3 — SAME contradiction, now corroborated -> slash agent B
   * ==================================================================== */
  section('SCENARIO 3 -- SAME contradiction, now corroborated by a third-party agreement backing agent A');

  // Shaped exactly like one entry of crossCheckBatches().agreements: a
  // THIRD, independent source (not agent A, not agent B) agrees with agent
  // A's value. That is the ground-truth signal Scenario 2 was missing.
  const agreement = {
    claimA: {
      provider: agentA.keyId,
      batchIndex: 1,
      claim: { subject: 'dispatch records that failed verification', value: 5, unit: 'percent', denominator: null }
    },
    claimB: {
      provider: 'third-party-agentC',
      batchIndex: 2,
      claim: { subject: 'dispatch records that failed verification', value: 6, unit: 'percent', denominator: null }
    },
    comparison: {
      relation: 'agree',
      reason: 'agent A (5%) and independent third party agentC (6%) agree within the peer tolerance',
      delta: null
    }
  };
  const verificationCorroborated = { contradictions: [contradiction], agreements: [agreement], unmatched: [] };
  console.log('same contradiction, PLUS a corroborating third-party agreement:');
  console.log(JSON.stringify(agreement, null, 2));
  line();

  console.log('BEFORE:');
  const beforeA3 = await printStake(contract, ethers, 'agent A', agentASigner);
  const beforeB3 = await printStake(contract, ethers, 'agent B', agentBSigner);
  line();

  const scenario3 = await evaluateAndSlash({
    qualityScoreEvent: null,
    verification: verificationCorroborated,
    registry,
    contract,
    arbiterSigner: deployer,
    ethers
  });
  console.log('evaluateAndSlash() result:');
  console.log(JSON.stringify(scenario3, null, 2));
  line();

  console.log('AFTER (expect: agent A untouched, agent B slashed):');
  const afterA3 = await printStake(contract, ethers, 'agent A', agentASigner);
  const afterB3 = await printStake(contract, ethers, 'agent B', agentBSigner);
  console.log(`agent A unchanged: ${beforeA3 === afterA3}`);
  console.log(`agent B slashed:   ${ethers.formatEther(beforeB3 - afterB3)} ETH`);
  line();

  console.log('demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
