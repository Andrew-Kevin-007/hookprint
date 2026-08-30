/**
 * policy/index.js — the real, callable end-to-end path: a QUORUM signal in,
 * a real on-chain `slash()` transaction out (or a recorded, never-silent
 * reason why not).
 *
 * Reuses client/index.js's existing contract-interaction code
 * (`deltaToSlashInput` / `slashFromInput`) rather than reimplementing it —
 * an `evaluate*` result is reshaped into the same Delta-like input shape
 * `deltaToSlashInput()` already validates and `slashFromInput()` already
 * knows how to submit, so this file adds policy, not a second way to talk
 * to the contract.
 */

'use strict';

const { deltaToSlashInput, slashFromInput } = require('../client');
const { evaluateBatchOutcome } = require('./slash-policy');

/**
 * evaluateAndSlash({ qualityScoreEvent, verification, registry, contract, arbiterSigner, thresholds, ethers })
 * -> Promise<Array<{ evaluation, txHash: string|null, skipped: boolean, skipReason: string|null }>>
 *
 * For every finding `evaluateBatchOutcome()` produces:
 *   - `shouldSlash === true`  -> a REAL `slash()` transaction is submitted
 *     (via `slashFromInput`), and the mined tx hash is recorded.
 *   - `shouldSlash === false` -> NOTHING is called on-chain, and the finding
 *     is still returned with `skipped: true` and its `evaluation.reason` —
 *     never silently dropped, per the task brief.
 *
 * @param {{
 *   qualityScoreEvent: object|null,
 *   verification: {contradictions:object[], agreements:object[], unmatched:object[]}|null,
 *   registry: ReturnType<typeof import('./identity-registry').createIdentityRegistry>,
 *   contract: import('ethers').Contract,
 *   arbiterSigner: import('ethers').Signer,
 *   thresholds?: object,
 *   ethers: typeof import('ethers')
 * }} args
 */
async function evaluateAndSlash({ qualityScoreEvent, verification, registry, contract, arbiterSigner, thresholds, ethers } = {}) {
  const findings = await evaluateBatchOutcome({ qualityScoreEvent, verification, registry, thresholds });
  const results = [];

  for (const evaluation of findings) {
    if (!evaluation.shouldSlash) {
      results.push({ evaluation, txHash: null, skipped: true, skipReason: evaluation.reason });
      continue;
    }

    const slashInput = deltaToSlashInput({
      class: evaluation.reasonClass,
      claimId: evaluation.claimId,
      agent: evaluation.agent,
      amountEth: evaluation.amountEth
    });
    const receipt = await slashFromInput(contract, ethers, arbiterSigner, slashInput);
    results.push({ evaluation, txHash: receipt?.hash ?? null, skipped: false, skipReason: null });
  }

  return results;
}

module.exports = { evaluateAndSlash };
