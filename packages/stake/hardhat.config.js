require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';
const SEPOLIA_PRIVATE_KEY = process.env.SEPOLIA_PRIVATE_KEY;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 }
    }
  },
  networks: {
    hardhat: {
      // default in-process chain — what `npm run demo:local` and `npm test` run against
    },
    // `npx hardhat node` serves this same in-process chain over JSON-RPC on :8545
    // so the demo script (or a UI) can attach to a long-lived local node instead.
    localhost: {
      url: 'http://127.0.0.1:8545'
    },
    // Bonus path — only usable once SEPOLIA_PRIVATE_KEY is set in .env and funded
    // via a faucet. Never required for the local-chain demo.
    ...(SEPOLIA_PRIVATE_KEY
      ? {
          sepolia: {
            url: SEPOLIA_RPC_URL,
            accounts: [SEPOLIA_PRIVATE_KEY]
          }
        }
      : {})
  },
  etherscan: {
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || ''
    }
  }
};
