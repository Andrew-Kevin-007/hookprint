const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

const { createIdentityRegistry } = require('../policy/identity-registry');
const {
  evaluateQualityFailure,
  evaluateContradiction,
  evaluateBatchOutcome
} = require('../policy/slash-policy');
const { evaluateAndSlash } = require('../policy');

const AGENT_A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const AGENT_B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

/** Mirrors packages/dispatch/quality/score.js's buildQualityScoreEvent() output shape exactly. */
function qualityScoreEvent({ provider, combinedScore, batchIndex = 0, taskId = 'task-1' }) {
  return {
    eventType: 'batch-quality-scored',
    taskId,
    provider,
    routeId: null,
    payload: {
      batchIndex,
      contextRatio: 0.5,
      deterministicScore: combinedScore,
      consistencyScore: combinedScore,
      combinedScore,
      weights: { deterministic: 0.35, consistency: 0.65 },
      reasons: ['test-fixture']
    },
    timestamp: '2026-01-01T00:00:00.000Z'
  };
}

/** Mirrors one entry of packages/dispatch/merge/consistency.js's crossCheckBatches().contradictions. */
function contradictionEntry({ providerA, batchIndexA = 0, valueA, providerB, batchIndexB = 1, valueB, subject = 'dispatch records that failed verification', delta = 0.5 }) {
  return {
    claimA: { provider: providerA, batchIndex: batchIndexA, claim: { subject, value: valueA, unit: 'percent', denominator: null } },
    claimB: { provider: providerB, batchIndex: batchIndexB, claim: { subject, value: valueB, unit: 'percent', denominator: null } },
    comparison: { relation: 'contradict', reason: 'test-fixture', delta }
  };
}

/** Mirrors one entry of crossCheckBatches().agreements. */
function agreementEntry({ providerA, batchIndexA, valueA, providerB, batchIndexB, valueB, subject = 'dispatch records that failed verification' }) {
  return {
    claimA: { provider: providerA, batchIndex: batchIndexA, claim: { subject, value: valueA, unit: 'percent', denominator: null } },
    claimB: { provider: providerB, batchIndex: batchIndexB, claim: { subject, value: valueB, unit: 'percent', denominator: null } },
    comparison: { relation: 'agree', reason: 'test-fixture', delta: null }
  };
}

/* -------------------------------------------------------------------------- */

describe('policy/identity-registry', function () {
  it('register + lookup round-trip', function () {
    const registry = createIdentityRegistry();
    registry.register('keyA', AGENT_A);
    expect(registry.lookup('keyA')).to.equal(AGENT_A);
    expect(registry.has('keyA')).to.equal(true);
  });

  it('lookup of an unregistered keyId returns null, never throws', function () {
    const registry = createIdentityRegistry();
    expect(() => registry.lookup('nope')).to.not.throw();
    expect(registry.lookup('nope')).to.equal(null);
    expect(registry.has('nope')).to.equal(false);
  });

  it('register rejects a malformed EVM address', function () {
    const registry = createIdentityRegistry();
    expect(() => registry.register('keyA', 'not-an-address')).to.throw(/well-formed EVM address/);
  });

  it('register rejects an empty keyId or address', function () {
    const registry = createIdentityRegistry();
    expect(() => registry.register('', AGENT_A)).to.throw();
    expect(() => registry.register('keyA', '')).to.throw();
  });
});

describe('policy/slash-policy -- evaluateQualityFailure', function () {
  it('a score below threshold triggers shouldSlash:true with a real, documented, proportional amount', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    const event = qualityScoreEvent({ provider: 'agentA', combinedScore: 0.1 });

    const result = evaluateQualityFailure(event, { registry });
    expect(result.shouldSlash).to.equal(true);
    expect(result.reasonClass).to.equal('quality_failure');
    expect(result.agent).to.equal(AGENT_A);
    expect(result.amountEth).to.be.a('number').greaterThan(0);
    expect(result.amountEth).to.be.at.most(0.5);
  });

  it('a score above threshold does not trigger a slash', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    const event = qualityScoreEvent({ provider: 'agentA', combinedScore: 0.9 });

    const result = evaluateQualityFailure(event, { registry });
    expect(result.shouldSlash).to.equal(false);
    expect(result.agent).to.equal(null);
    expect(result.amountEth).to.equal(0);
  });

  it('an unregistered agent never triggers a slash regardless of how bad the score is', function () {
    const registry = createIdentityRegistry();
    const event = qualityScoreEvent({ provider: 'ghost', combinedScore: 0.0 });

    const result = evaluateQualityFailure(event, { registry });
    expect(result.shouldSlash).to.equal(false);
    expect(result.reason).to.equal('agent_not_registered');
  });

  it('worse scores slash more (severity is monotonic), up to the documented cap', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    const worst = evaluateQualityFailure(qualityScoreEvent({ provider: 'agentA', combinedScore: 0.0 }), { registry });
    const mild = evaluateQualityFailure(qualityScoreEvent({ provider: 'agentA', combinedScore: 0.39 }), { registry });
    expect(worst.amountEth).to.be.greaterThan(mild.amountEth);
    expect(worst.amountEth).to.equal(0.5); // MAX_SLASH_AMOUNT_ETH cap, reached at combinedScore 0
  });
});

describe('policy/slash-policy -- evaluateContradiction', function () {
  it('a bare contradiction with no corroboration does NOT trigger a slash', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    registry.register('agentB', AGENT_B);
    const contradiction = contradictionEntry({ providerA: 'agentA', valueA: 5, providerB: 'agentB', valueB: 60 });

    const result = evaluateContradiction(contradiction, {
      registry,
      verification: { contradictions: [contradiction], agreements: [], unmatched: [] }
    });
    expect(result.shouldSlash).to.equal(false);
    expect(result.reason).to.equal('contradiction_detected_no_ground_truth');
    expect(result.agent).to.equal(null);
  });

  it('the SAME contradiction WITH corroborating third-party agreement DOES trigger a slash against the uncorroborated side, never the corroborated side', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    registry.register('agentB', AGENT_B);
    // agentA (5%) and agentB (60%) disagree. A THIRD, independent source (agentC) agrees with agentA.
    const contradiction = contradictionEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentB', batchIndexB: 1, valueB: 60 });
    const agreement = agreementEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentC', batchIndexB: 2, valueB: 6 });
    const verification = { contradictions: [contradiction], agreements: [agreement], unmatched: [] };

    const result = evaluateContradiction(contradiction, { registry, verification });
    expect(result.shouldSlash).to.equal(true);
    expect(result.agent).to.equal(AGENT_B); // agentB is the uncorroborated/wrong side
    expect(result.reason).to.equal('contradiction_corroborated_by_third_party_agreement');
  });

  it('the SAME contradiction WITH corroborating independent quality failure DOES trigger a slash against the correlated/wrong side, never the other', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    registry.register('agentB', AGENT_B);
    const contradiction = contradictionEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentB', batchIndexB: 1, valueB: 60 });
    const correlatedQualityFailures = new Set(['agentB:1']); // agentB's OWN batch independently failed quality

    const result = evaluateContradiction(contradiction, {
      registry,
      verification: { contradictions: [contradiction], agreements: [], unmatched: [] },
      correlatedQualityFailures
    });
    expect(result.shouldSlash).to.equal(true);
    expect(result.agent).to.equal(AGENT_B);
    expect(result.reason).to.equal('contradiction_corroborated_by_independent_quality_failure');
  });

  it('an unregistered wrong-side agent never triggers a slash even when corroborated', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A); // agentB deliberately NOT registered
    const contradiction = contradictionEntry({ providerA: 'agentA', valueA: 5, providerB: 'agentB', valueB: 60 });
    const agreement = agreementEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentC', batchIndexB: 2, valueB: 6 });

    const result = evaluateContradiction(contradiction, {
      registry,
      verification: { contradictions: [contradiction], agreements: [agreement], unmatched: [] }
    });
    expect(result.shouldSlash).to.equal(false);
    expect(result.reason).to.equal('agent_not_registered');
  });

  it('when BOTH sides are flagged corroborated-wrong, refuses to pick one (fail-closed)', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    registry.register('agentB', AGENT_B);
    const contradiction = contradictionEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentB', batchIndexB: 1, valueB: 60 });
    const correlatedQualityFailures = new Set(['agentA:0', 'agentB:1']);

    const result = evaluateContradiction(contradiction, {
      registry,
      verification: { contradictions: [contradiction], agreements: [], unmatched: [] },
      correlatedQualityFailures
    });
    expect(result.shouldSlash).to.equal(false);
    expect(result.reason).to.equal('contradiction_corroboration_ambiguous_both_sides_flagged');
  });
});

describe('policy/slash-policy -- evaluateBatchOutcome wiring', function () {
  it('quality_failure and contradiction fire as two separate, distinctly-tagged findings for the same agent', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    registry.register('agentB', AGENT_B);
    const event = qualityScoreEvent({ provider: 'agentB', batchIndex: 1, combinedScore: 0.1 });
    const contradiction = contradictionEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentB', batchIndexB: 1, valueB: 60 });
    const verification = { contradictions: [contradiction], agreements: [], unmatched: [] };

    const findings = evaluateBatchOutcome({ qualityScoreEvent: event, verification, registry });
    expect(findings).to.have.lengthOf(2);
    expect(findings[0].reasonClass).to.equal('quality_failure');
    expect(findings[0].shouldSlash).to.equal(true);
    expect(findings[0].agent).to.equal(AGENT_B);
    expect(findings[1].reasonClass).to.equal('contradiction');
    expect(findings[1].shouldSlash).to.equal(true);
    expect(findings[1].agent).to.equal(AGENT_B);
    expect(findings[1].reason).to.equal('contradiction_corroborated_by_independent_quality_failure');
  });

  it('no qualityScoreEvent given: only contradiction findings are produced', function () {
    const registry = createIdentityRegistry();
    registry.register('agentA', AGENT_A);
    registry.register('agentB', AGENT_B);
    const contradiction = contradictionEntry({ providerA: 'agentA', valueA: 5, providerB: 'agentB', valueB: 60 });
    const verification = { contradictions: [contradiction], agreements: [], unmatched: [] };

    const findings = evaluateBatchOutcome({ qualityScoreEvent: null, verification, registry });
    expect(findings).to.have.lengthOf(1);
    expect(findings[0].reasonClass).to.equal('contradiction');
  });
});

describe('policy/index -- evaluateAndSlash (real local Hardhat contract)', function () {
  async function deployFixture() {
    const [deployer, agentASigner, agentBSigner] = await ethers.getSigners();
    const AgentStake = await ethers.getContractFactory('AgentStake');
    const contract = await AgentStake.deploy();
    await contract.waitForDeployment();
    return { contract, deployer, agentASigner, agentBSigner };
  }

  it('executes a real slash() transaction when warranted, and changes the real on-chain balance', async function () {
    const { contract, deployer, agentASigner } = await loadFixture(deployFixture);
    await contract.connect(agentASigner).stake({ value: ethers.parseEther('1.0') });

    const registry = createIdentityRegistry();
    registry.register('agentA', agentASigner.address);

    const [beforeAmount] = await contract.stakeOf(agentASigner.address);
    const event = qualityScoreEvent({ provider: 'agentA', combinedScore: 0.1 });

    const results = await evaluateAndSlash({
      qualityScoreEvent: event,
      verification: null,
      registry,
      contract,
      arbiterSigner: deployer,
      ethers
    });

    expect(results).to.have.lengthOf(1);
    expect(results[0].skipped).to.equal(false);
    expect(results[0].txHash).to.be.a('string');

    const [afterAmount] = await contract.stakeOf(agentASigner.address);
    expect(afterAmount).to.be.lessThan(beforeAmount);
    const expectedSlashWei = ethers.parseEther(String(results[0].evaluation.amountEth));
    expect(beforeAmount - afterAmount).to.equal(expectedSlashWei);
  });

  it('does NOT call the contract at all when not warranted -- real on-chain balance is unchanged', async function () {
    const { contract, deployer, agentASigner } = await loadFixture(deployFixture);
    await contract.connect(agentASigner).stake({ value: ethers.parseEther('1.0') });

    const registry = createIdentityRegistry();
    registry.register('agentA', agentASigner.address);

    const [beforeAmount] = await contract.stakeOf(agentASigner.address);
    const event = qualityScoreEvent({ provider: 'agentA', combinedScore: 0.9 }); // above threshold

    const results = await evaluateAndSlash({
      qualityScoreEvent: event,
      verification: null,
      registry,
      contract,
      arbiterSigner: deployer,
      ethers
    });

    expect(results).to.have.lengthOf(1);
    expect(results[0].skipped).to.equal(true);
    expect(results[0].txHash).to.equal(null);

    const [afterAmount] = await contract.stakeOf(agentASigner.address);
    expect(afterAmount).to.equal(beforeAmount);
  });

  it('runs a corroborated contradiction end-to-end against the real contract and slashes only the wrong side', async function () {
    const { contract, deployer, agentASigner, agentBSigner } = await loadFixture(deployFixture);
    await contract.connect(agentASigner).stake({ value: ethers.parseEther('1.0') });
    await contract.connect(agentBSigner).stake({ value: ethers.parseEther('1.0') });

    const registry = createIdentityRegistry();
    registry.register('agentA', agentASigner.address);
    registry.register('agentB', agentBSigner.address);

    const contradiction = contradictionEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentB', batchIndexB: 1, valueB: 60 });
    const agreement = agreementEntry({ providerA: 'agentA', batchIndexA: 0, valueA: 5, providerB: 'agentC', batchIndexB: 2, valueB: 6 });
    const verification = { contradictions: [contradiction], agreements: [agreement], unmatched: [] };

    const [beforeA] = await contract.stakeOf(agentASigner.address);
    const [beforeB] = await contract.stakeOf(agentBSigner.address);

    const results = await evaluateAndSlash({
      qualityScoreEvent: null,
      verification,
      registry,
      contract,
      arbiterSigner: deployer,
      ethers
    });

    expect(results).to.have.lengthOf(1);
    expect(results[0].skipped).to.equal(false);
    expect(results[0].evaluation.agent).to.equal(agentBSigner.address);

    const [afterA] = await contract.stakeOf(agentASigner.address);
    const [afterB] = await contract.stakeOf(agentBSigner.address);
    expect(afterA).to.equal(beforeA); // agentA (corroborated side) untouched
    expect(afterB).to.be.lessThan(beforeB); // agentB (uncorroborated/wrong side) slashed
  });
});
