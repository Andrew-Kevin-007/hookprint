/**
 * scripts/deploy.js — deploy AgentStake to whatever network Hardhat was
 * invoked with (`--network sepolia` for the testnet bonus path; defaults to
 * the ephemeral in-process "hardhat" network otherwise).
 *
 * Usage:
 *   npm run deploy:sepolia   (requires SEPOLIA_PRIVATE_KEY in .env, funded)
 */
const { ethers, network } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`network:  ${network.name}`);
  console.log(`deployer: ${deployer.address}`);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`balance:  ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) {
    console.warn('WARNING: deployer has 0 balance — deployment will fail until funded via a faucet.');
  }

  const AgentStake = await ethers.getContractFactory('AgentStake');
  const contract = await AgentStake.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`AgentStake deployed at: ${address}`);
  if (network.name === 'sepolia') {
    console.log(`Explorer: https://sepolia.etherscan.io/address/${address}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
