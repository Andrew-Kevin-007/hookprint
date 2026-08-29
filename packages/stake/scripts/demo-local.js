/**
 * scripts/demo-local.js — the exact sequence that runs live on stage.
 *
 * Run with `npm run demo:local` (== `hardhat run scripts/demo-local.js`).
 * Hardhat's `run` task spins up a brand-new in-process chain for the
 * duration of the script — every run starts from a clean local node, no
 * separate `hardhat node` process required.
 *
 * Sequence: deploy AgentStake -> fund two demo accounts -> agent stakes ->
 * print before-balance -> load a REJECT-verdict-shaped JSON fixture -> arbiter
 * slashes -> print after-balance and the emitted Slashed event.
 */
const { ethers } = require('hardhat');
const path = require('path');
const { deltaToSlashInput, getStake, stakeAs, slashFromInput } = require('../client');

const FIXTURE_PATH = process.env.BATON_SLASH_FIXTURE || path.join(__dirname, '..', 'fixtures', 'reject-verdict.json');

function line() {
  console.log('-'.repeat(72));
}

async function main() {
  console.log('BATON stake/slash — local chain demo');
  line();

  const [deployer, agentSigner] = await ethers.getSigners();
  console.log(`arbiter (deployer): ${deployer.address}`);
  console.log(`agent:              ${agentSigner.address}`);
  line();

  const AgentStake = await ethers.getContractFactory('AgentStake');
  const contract = await AgentStake.deploy();
  await contract.waitForDeployment();
  console.log(`AgentStake deployed at: ${await contract.getAddress()}`);
  line();

  // The agent stakes 1.0 ETH against its own future claims.
  const STAKE_AMOUNT_ETH = '1.0';
  console.log(`agent stakes ${STAKE_AMOUNT_ETH} ETH...`);
  await stakeAs(contract, ethers, agentSigner, STAKE_AMOUNT_ETH);

  const before = await getStake(contract, ethers, agentSigner.address);
  console.log(`BEFORE  amount=${before.amountEth} ETH  active=${before.active}`);
  line();

  // This is the shape a real integration would receive from packages/align's
  // gate() REJECT verdict (a Delta — see packages/align/contract.js) plus the
  // two on-chain-only fields (agent address, slash amount) a registry/policy
  // layer would need to supply. See client/index.js's module header for why
  // a raw Delta alone is not enough.
  console.log(`reading REJECT-verdict fixture: ${FIXTURE_PATH}`);
  const delta = require(FIXTURE_PATH);
  console.log('fixture (Delta-shaped input):');
  console.log(JSON.stringify(delta, null, 2));
  line();

  const slashInput = deltaToSlashInput(delta);
  if (slashInput.agent.toLowerCase() !== agentSigner.address.toLowerCase()) {
    throw new Error(
      `fixture agent ${slashInput.agent} does not match the demo agent signer ${agentSigner.address} — ` +
        'update the fixture or the signer index'
    );
  }

  console.log(`arbiter slashes ${slashInput.amountEth} ETH from ${slashInput.agent}`);
  console.log(`  claimId=${slashInput.claimId}  reasonClass=${slashInput.reasonClass}`);
  const receipt = await slashFromInput(contract, ethers, deployer, slashInput);

  const slashedEvent = receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'Slashed');

  line();
  console.log('emitted Slashed event:');
  console.log(
    JSON.stringify(
      {
        agent: slashedEvent.args.agent,
        amount: ethers.formatEther(slashedEvent.args.amount) + ' ETH',
        remaining: ethers.formatEther(slashedEvent.args.remaining) + ' ETH',
        claimId: slashedEvent.args.claimId,
        reasonClass: slashedEvent.args.reasonClass
      },
      null,
      2
    )
  );
  line();

  const after = await getStake(contract, ethers, agentSigner.address);
  console.log(`AFTER   amount=${after.amountEth} ETH  active=${after.active}`);
  line();

  console.log(`stake reduced: ${before.amountEth} ETH -> ${after.amountEth} ETH`);
  console.log('demo complete.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
