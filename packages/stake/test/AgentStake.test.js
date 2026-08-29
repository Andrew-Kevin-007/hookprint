const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

describe('AgentStake', function () {
  async function deployFixture() {
    const [deployer, agent, other] = await ethers.getSigners();
    const AgentStake = await ethers.getContractFactory('AgentStake');
    const contract = await AgentStake.deploy();
    // deployer is the arbiter (constructor sets arbiter = msg.sender)
    return { contract, deployer, agent, other };
  }

  it('sets the deployer as arbiter', async function () {
    const { contract, deployer } = await loadFixture(deployFixture);
    expect(await contract.arbiter()).to.equal(deployer.address);
  });

  it('stake() succeeds and updates the agent balance', async function () {
    const { contract, agent } = await loadFixture(deployFixture);
    const amount = ethers.parseEther('1.0');

    await expect(contract.connect(agent).stake({ value: amount }))
      .to.emit(contract, 'Staked')
      .withArgs(agent.address, amount, amount);

    const [balance, active] = await contract.stakeOf(agent.address);
    expect(balance).to.equal(amount);
    expect(active).to.equal(true);
  });

  it('stake() reverts on a zero-value call', async function () {
    const { contract, agent } = await loadFixture(deployFixture);
    await expect(contract.connect(agent).stake({ value: 0 })).to.be.revertedWith('AgentStake: stake must be > 0');
  });

  it('stake() accumulates across multiple calls', async function () {
    const { contract, agent } = await loadFixture(deployFixture);
    await contract.connect(agent).stake({ value: ethers.parseEther('1.0') });
    await contract.connect(agent).stake({ value: ethers.parseEther('0.5') });
    const [balance] = await contract.stakeOf(agent.address);
    expect(balance).to.equal(ethers.parseEther('1.5'));
  });

  it('slash() by the arbiter succeeds, reduces balance, and emits with the right claimId/reasonClass', async function () {
    const { contract, deployer, agent } = await loadFixture(deployFixture);
    const staked = ethers.parseEther('1.0');
    const slashed = ethers.parseEther('0.4');
    await contract.connect(agent).stake({ value: staked });

    await expect(contract.connect(deployer).slash(agent.address, slashed, 'c_014', 'denominator_loss'))
      .to.emit(contract, 'Slashed')
      .withArgs(agent.address, slashed, staked - slashed, 'c_014', 'denominator_loss');

    const [balance] = await contract.stakeOf(agent.address);
    expect(balance).to.equal(staked - slashed);
  });

  it('slash() moves the slashed amount to the arbiter', async function () {
    const { contract, deployer, agent } = await loadFixture(deployFixture);
    const staked = ethers.parseEther('1.0');
    const slashed = ethers.parseEther('0.4');
    await contract.connect(agent).stake({ value: staked });

    await expect(
      contract.connect(deployer).slash(agent.address, slashed, 'c_014', 'denominator_loss')
    ).to.changeEtherBalances([contract, deployer], [-slashed, slashed]);
  });

  it('slash() by a non-arbiter reverts', async function () {
    const { contract, agent, other } = await loadFixture(deployFixture);
    await contract.connect(agent).stake({ value: ethers.parseEther('1.0') });

    await expect(
      contract.connect(other).slash(agent.address, ethers.parseEther('0.1'), 'c_014', 'denominator_loss')
    ).to.be.revertedWith('AgentStake: only arbiter');
  });

  it('slash() of more than the current stake reverts', async function () {
    const { contract, deployer, agent } = await loadFixture(deployFixture);
    await contract.connect(agent).stake({ value: ethers.parseEther('1.0') });

    await expect(
      contract.connect(deployer).slash(agent.address, ethers.parseEther('2.0'), 'c_014', 'denominator_loss')
    ).to.be.revertedWith('AgentStake: insufficient stake');
  });

  it('slash() of the entire stake deactivates it', async function () {
    const { contract, deployer, agent } = await loadFixture(deployFixture);
    const staked = ethers.parseEther('1.0');
    await contract.connect(agent).stake({ value: staked });
    await contract.connect(deployer).slash(agent.address, staked, 'c_014', 'denominator_loss');

    const [balance, active] = await contract.stakeOf(agent.address);
    expect(balance).to.equal(0);
    expect(active).to.equal(false);
  });

  it('unstake() reduces balance and transfers funds back to the agent', async function () {
    const { contract, agent } = await loadFixture(deployFixture);
    const staked = ethers.parseEther('1.0');
    const withdrawn = ethers.parseEther('0.6');
    await contract.connect(agent).stake({ value: staked });

    await expect(contract.connect(agent).unstake(withdrawn)).to.changeEtherBalances(
      [contract, agent],
      [-withdrawn, withdrawn - 0n] // gas is paid separately by the sender; changeEtherBalances already accounts for it
    );

    const [balance] = await contract.stakeOf(agent.address);
    expect(balance).to.equal(staked - withdrawn);
  });

  it('unstake() emits Unstaked with the right amount and remaining balance', async function () {
    const { contract, agent } = await loadFixture(deployFixture);
    const staked = ethers.parseEther('1.0');
    const withdrawn = ethers.parseEther('0.6');
    await contract.connect(agent).stake({ value: staked });

    await expect(contract.connect(agent).unstake(withdrawn))
      .to.emit(contract, 'Unstaked')
      .withArgs(agent.address, withdrawn, staked - withdrawn);
  });

  it('unstake() more than available reverts', async function () {
    const { contract, agent } = await loadFixture(deployFixture);
    await contract.connect(agent).stake({ value: ethers.parseEther('1.0') });

    await expect(contract.connect(agent).unstake(ethers.parseEther('2.0'))).to.be.revertedWith(
      'AgentStake: amount exceeds stake'
    );
  });

  it('unstake() with no active stake reverts', async function () {
    const { contract, other } = await loadFixture(deployFixture);
    await expect(contract.connect(other).unstake(1)).to.be.revertedWith('AgentStake: no active stake');
  });
});
