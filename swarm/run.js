#!/usr/bin/env node
/**
 * BATON — swarm/run.js
 *
 * CLI entry point for the live swarm pipeline. Runs researcher ->
 * summariser -> writer against a real Anthropic model N times (default 8,
 * inside BUILD-PLAN.md's "5-10 runs"), writing every run's three hop
 * documents to disk as plain prose.
 *
 * This script does NOT decide which run shows organic corruption — that
 * judgement takes a human actually reading the three files. It deliberately
 * never imports packages/align to make that call (BUILD-PLAN.md "OUT: any
 * LLM in the checker. Agents are models; the checker is not." — the same
 * rule applies in reverse here: the checker is not an agent, and this
 * generator is not a checker). See README.md "Workflow: from a generated
 * run to a demo fixture" for what to do with the output.
 *
 * Usage:
 *   node run.js                        # 8 runs, written to ../fixtures/generated/
 *   node run.js --runs 5
 *   node run.js --runs 3 --out ./tmp
 *   node run.js --scenario "..."       # force the same scenario every run
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createClient, generate as callModel, hasEnvCredential, MODEL } from './lib/client.js';
import { runPipeline } from './lib/pipeline.js';
import { writeBriefs } from './lib/save.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { runs: 8, out: path.join(here, '..', 'fixtures', 'generated'), scenario: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--scenario') args.scenario = argv[++i];
    else {
      console.error(`Unrecognised argument: ${a}`);
      process.exit(1);
    }
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    console.error(`--runs must be a positive integer, got ${args.runs}`);
    process.exit(1);
  }
  return args;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasEnvCredential()) {
    console.log(
      'No ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found in the environment. ' +
        'Trying anyway, in case an `ant auth login` profile is active — the SDK ' +
        'resolves credentials itself and this check is only a local hint.\n'
    );
  }

  const client = createClient();
  const generate = (prompt) => callModel(client, prompt);

  console.log(`BATON swarm — running the researcher/summariser/writer pipeline ${args.runs} time(s) against ${MODEL}.`);
  console.log(`Output: ${args.out}\n`);

  const results = [];
  for (let i = 1; i <= args.runs; i++) {
    const runDir = path.join(args.out, `run-${pad(i)}`);
    process.stdout.write(`  run-${pad(i)} ... `);
    try {
      const result = await runPipeline(generate, { scenario: args.scenario });
      const paths = writeBriefs(runDir, result);
      const preview = result.scenario.length > 60 ? `${result.scenario.slice(0, 60)}…` : result.scenario;
      console.log(`ok (scenario: "${preview}")`);
      results.push({ run: i, dir: runDir, scenario: result.scenario, paths });
    } catch (err) {
      console.log('FAILED');
      // Two distinct "no usable credential" shapes, and both need the same
      // friendly message: a real 401 from the API surfaces as the typed
      // Anthropic.AuthenticationError, but when NO credential is configured
      // at all the SDK never reaches the network — it throws a plain Error
      // at header-build time ("Could not resolve authentication method...").
      // That one is not an instanceof APIError (there was no HTTP response
      // to derive it from), so it needs its own check or it falls through
      // to the generic branch below and prints a raw stack trace instead of
      // guidance. Confirmed by reproducing this exact failure with no key
      // set — see swarm/README.md "Verification" for the transcript.
      const noCredentialConfigured =
        err instanceof Anthropic.AuthenticationError || /could not resolve authentication method/i.test(err.message ?? '');
      if (noCredentialConfigured) {
        console.error(
          '\nAuthentication failed. No usable Anthropic credential was found by the SDK ' +
            '(checked ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, and any `ant auth login` profile). ' +
            'Set ANTHROPIC_API_KEY and re-run, or run `ant auth login`.'
        );
        process.exitCode = 1;
        break; // every subsequent call will fail the same way — stop burning runs
      } else if (err instanceof Anthropic.RateLimitError) {
        console.error('  rate limited on this run — continuing to the next one.');
      } else if (err instanceof Anthropic.APIError) {
        console.error(`  API error (${err.status}) on this run: ${err.message} — continuing to the next one.`);
      } else {
        console.error(`  ${err.stack || err.message} — continuing to the next one.`);
      }
      process.exitCode = 1;
    }
  }

  if (results.length > 0) {
    console.log(
      `\n${results.length} run(s) written under ${args.out}.\n` +
        "Next: read each run-NN/hop-*.md by hand. Any run where the writer's " +
        "(or summariser's) restatement drops a denominator, drifts a value, changes " +
        'a unit, or silently loses a caveat present upstream is a genuine organic-' +
        'corruption fixture. Copy its three files into swarm/briefs/ as the primary ' +
        "live-demo fixture and write what changed into a MANIFEST.md next to it — see " +
        'README.md "Workflow: from a generated run to a demo fixture".'
    );
  }
}

main();
