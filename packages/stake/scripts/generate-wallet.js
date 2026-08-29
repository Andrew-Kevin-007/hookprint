/**
 * scripts/generate-wallet.js — one-off helper for the testnet bonus path.
 *
 * No funded wallet was found configured in this environment (checked env vars
 * for PRIVATE_KEY/WALLET/SEPOLIA/INFURA/ALCHEMY/RPC/MNEMONIC — none present).
 * This generates a fresh secp256k1 keypair, prints the address to fund via a
 * public Sepolia faucet, and writes the private key ONLY to a local .env
 * (gitignored) — never to stdout history beyond this one run, never committed.
 *
 * Usage: node scripts/generate-wallet.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const wallet = ethers.Wallet.createRandom();
const envPath = path.join(__dirname, '..', '.env');

const envLines = [
  `SEPOLIA_PRIVATE_KEY=${wallet.privateKey}`,
  'SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com',
  'ETHERSCAN_API_KEY='
];

fs.writeFileSync(envPath, envLines.join('\n') + '\n', { encoding: 'utf8', flag: 'w' });

console.log('Generated a fresh testnet wallet.');
console.log(`Address:     ${wallet.address}`);
console.log(`Private key: written to ${envPath} (gitignored, not printed here)`);
console.log('');
console.log('Fund it via a Sepolia faucet, e.g.:');
console.log('  https://sepoliafaucet.com/');
console.log('  https://www.alchemy.com/faucets/ethereum-sepolia');
console.log(`  (paste address: ${wallet.address})`);
console.log('');
console.log('Once funded, run: npm run deploy:sepolia');
