#!/usr/bin/env node
/**
 * bin/quorum.js — the QUORUM CLI.
 *
 * This is the first entry point that runs the project as ONE thing, rather
 * than five worktree-local packages nobody could invoke together. It is
 * deliberately small: it does not attempt the merge/routing pipeline (that
 * is a later phase in the build plan). What it does today is make "is this
 * repo healthy" and "does the honesty benchmark still hold" both a single
 * command, runnable from a fresh clone.
 *
 *   quorum test       run every package's test suite, PASS/FAIL per package + total
 *   quorum bench      run the real corruption benchmark (bench/run.js) and print it
 *   quorum campaign   run the degradation-measurement campaign (bench/degradation/)
 *                     against every provider with real credentials found in the
 *                     environment; prints a clear message and does nothing else if
 *                     none are found
 *   quorum --help     list commands
 *
 * `test` and `bench` make no network calls and require no API keys, same as
 * before this file grew a `campaign` command. `campaign` is the one command
 * here that DOES make real network calls, and only for providers whose key
 * env var is actually present — see `cmdCampaign()` below.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Load real provider keys from a repo-root `.env` (gitignored — see
 * `.env.example` for the exact var names each adapter reads) before any
 * command runs. Uses Node's native `process.loadEnvFile()` (stable on this
 * project's Node 24) — zero new dependencies, consistent with this
 * codebase's zero-dependency-where-possible convention elsewhere.
 *
 * Silent no-op when `.env` doesn't exist: `quorum test`/`quorum bench` must
 * keep working on a fresh clone with no keys at all, and `quorum campaign`
 * already has its own clear "no credentials found" message for that case.
 */
const ENV_FILE = join(ROOT, '.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
}

/** *.test.js files directly inside a directory, as bare filenames — matches each package's own `tests/*.test.js` script. */
function testFiles(relDir) {
  const abs = join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((f) => f.endsWith('.test.js')).sort();
}

/**
 * A package that runs on `node --test` over its own tests/ directory.
 * command is process.execPath — a real absolute path (on Windows typically
 * "C:\Program Files\nodejs\node.exe", containing a space) — so it is spawned
 * directly with shell:false. A shell would re-split that path on the space
 * and fail with "'C:\Program' is not recognized...".
 */
function nodePackage(name, pkgRelDir) {
  const files = testFiles(join(pkgRelDir, 'tests'));
  return {
    name,
    cwd: pkgRelDir,
    command: process.execPath,
    args: ['--test', ...files.map((f) => join('tests', f))],
    shell: false
  };
}

const PACKAGES = [
  nodePackage('align', 'packages/align'),
  nodePackage('sign', 'packages/sign'),
  nodePackage('registry', 'packages/registry'),
  // stake is Solidity/Hardhat, not node --test — verified separately as `npx hardhat test`.
  // npx resolves to npx.cmd on Windows, which needs a shell to execute at all.
  { name: 'stake', cwd: 'packages/stake', command: 'npx', args: ['hardhat', 'test'], shell: true },
  nodePackage('dispatch', 'packages/dispatch')
];

function runPackageTests(pkg) {
  const cwd = join(ROOT, pkg.cwd);
  const result = spawnSync(pkg.command, pkg.args, { cwd, encoding: 'utf8', shell: pkg.shell ?? false });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const passed = result.status === 0 && !result.error;
  return { ...pkg, output, passed };
}

/**
 * Best-effort one-line summary pulled from raw test-runner output — `node --test`'s
 * own "i pass N" / "i fail N" / "i tests N" lines, or Mocha/Hardhat's "N passing".
 * Falls back to nothing (just PASS/FAIL) if neither format is recognised, so a
 * future runner change degrades gracefully instead of printing a wrong count.
 */
function summarize(output) {
  const passMatch = output.match(/[a-zℹ] pass (\d+)/i) || output.match(/(\d+) passing/);
  if (!passMatch) return null;
  const failMatch = output.match(/[a-zℹ] fail (\d+)/i) || output.match(/(\d+) failing/);
  const testsMatch = output.match(/[a-zℹ] tests (\d+)/i);
  const pass = Number(passMatch[1]);
  const fail = failMatch ? Number(failMatch[1]) : 0;
  const total = testsMatch ? Number(testsMatch[1]) : pass + fail;
  return `${pass}/${total}`;
}

function cmdTest() {
  console.log('QUORUM - running every package test suite');
  console.log('');
  const results = PACKAGES.map((pkg) => {
    process.stdout.write(`  ${pkg.name.padEnd(10)} ... `);
    const r = runPackageTests(pkg);
    const summary = summarize(r.output);
    console.log(`${r.passed ? 'PASS' : 'FAIL'}${summary ? `  (${summary} tests)` : ''}`);
    if (!r.passed) {
      console.log('');
      console.log(`--- ${pkg.name} output ---`);
      console.log(r.output.trim());
      console.log(`--- end ${pkg.name} ---`);
      console.log('');
    }
    return r;
  });

  console.log('');
  console.log('-'.repeat(50));
  console.log('SUMMARY');
  let totalPass = 0;
  let totalTests = 0;
  let anyUnknown = false;
  for (const r of results) {
    const summary = summarize(r.output);
    console.log(`  ${r.passed ? 'OK  ' : 'FAIL'} ${r.name.padEnd(10)} ${r.passed ? 'PASS' : 'FAIL'}${summary ? `   ${summary}` : ''}`);
    if (summary) {
      const [p, t] = summary.split('/').map(Number);
      totalPass += p;
      totalTests += t;
    } else {
      anyUnknown = true;
    }
  }
  console.log('-'.repeat(50));
  const allPass = results.every((r) => r.passed);
  const totalLine = anyUnknown ? '' : `  (${totalPass}/${totalTests} tests)`;
  console.log(`${allPass ? 'ALL PACKAGES PASS' : 'SOME PACKAGES FAILED'}${totalLine}`);
  process.exitCode = allPass ? 0 : 1;
}

function cmdBench() {
  const extraArgs = process.argv.slice(3);
  const result = spawnSync(process.execPath, [join(ROOT, 'bench', 'run.js'), ...extraArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false
  });
  process.exitCode = result.status ?? 1;
}

/**
 * One or more env vars that would let that provider's adapter construct a
 * real client (see each executor/*.js `createClient()`'s own doc comment
 * for which var(s) its SDK resolves). Gemini accepts either name — its SDK
 * (`@google/genai`) resolves `GEMINI_API_KEY` OR `GOOGLE_API_KEY`.
 */
const PROVIDER_ENV_VARS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY']
};

/** Providers (in PROVIDER_ENV_VARS order) whose credential env var is
 * actually present right now. Never throws, never assumes a key exists. */
function findAvailableProviders() {
  return Object.entries(PROVIDER_ENV_VARS)
    .filter(([, envVars]) => envVars.some((name) => Boolean(process.env[name])))
    .map(([provider]) => provider);
}

/**
 * `quorum campaign` — run the Phase 3 degradation-measurement campaign
 * (bench/degradation/) for real. Skips any provider with no credential env
 * var present rather than failing the whole run; if NO provider has one,
 * prints a clear message and does nothing else (no partial ledger writes,
 * no network calls attempted).
 */
async function cmdCampaign() {
  const availableProviders = findAvailableProviders();

  if (availableProviders.length === 0) {
    console.log('no provider credentials found; the harness is ready, supply API keys via environment variables to run a real campaign');
    console.log('');
    console.log('Expected env vars (any subset — a provider with none set is simply skipped):');
    for (const [provider, envVars] of Object.entries(PROVIDER_ENV_VARS)) {
      console.log(`  ${provider.padEnd(11)} ${envVars.join(' or ')}`);
    }
    return;
  }

  // Dynamic import() requires a file:// URL, not a raw filesystem path — on
  // Windows, a bare "D:\..." path is rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME
  // (confirmed by running this exact command on this machine before this fix).
  const { buildCampaignPlan, loadRealCorpusChunks, BATCH_SIZES, REPETITIONS_PER_CELL, validateBatchSizesAgainstProviderCeilings } =
    await import(pathToFileURL(join(ROOT, 'bench', 'degradation', 'campaign.js')));
  const { runCampaign } = await import(pathToFileURL(join(ROOT, 'bench', 'degradation', 'runner.js')));
  const { getProviderAdapter } = await import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'executor', 'index.js')));

  const ceilingCheck = validateBatchSizesAgainstProviderCeilings(BATCH_SIZES, availableProviders);
  if (!ceilingCheck.ok) {
    console.error('BATCH_SIZES violates a provider maxBatchSize ceiling — refusing to run:');
    console.error(JSON.stringify(ceilingCheck.violations, null, 2));
    process.exitCode = 1;
    return;
  }

  console.log(`QUORUM degradation campaign — credentials found for: ${availableProviders.join(', ')}`);
  const skippedProviders = Object.keys(PROVIDER_ENV_VARS).filter((p) => !availableProviders.includes(p));
  if (skippedProviders.length > 0) {
    console.log(`(no credentials — skipped: ${skippedProviders.join(', ')})`);
  }

  const corpus = loadRealCorpusChunks();
  const plan = buildCampaignPlan(corpus, BATCH_SIZES, availableProviders, REPETITIONS_PER_CELL);
  const ledgerPath = join(ROOT, 'bench', 'degradation', 'campaign-ledger.jsonl');
  console.log(`plan: ${plan.length} cells (${availableProviders.length} providers x ${BATCH_SIZES.length} batch sizes x ${REPETITIONS_PER_CELL} repetitions)`);
  console.log(`ledger: ${ledgerPath}`);
  console.log('');

  const getClient = (provider) => getProviderAdapter(provider).createClient();

  const { results, haltedProviders, skipped } = await runCampaign(plan, {
    getClient,
    ledgerPath,
    onProgress: (cell, result) => {
      const label = `${cell.provider.padEnd(11)} bs=${String(cell.batchSize).padEnd(3)} r=${cell.repetition}`;
      if (result?.skipped) {
        console.log(`  [skip] ${label} — ${result.reason}`);
      } else {
        const quality = Number.isFinite(result.qualityScore) ? result.qualityScore.toFixed(3) : 'n/a';
        console.log(`  [${result.status}] ${label} quality=${quality} latency=${result.latencyMs}ms tokens=${result.actualTokens}`);
      }
    }
  });

  console.log('');
  console.log(`Campaign run finished: ${results.length} cell(s) executed, ${skipped.length} skipped, ${plan.length} total in plan.`);
  if (haltedProviders.length > 0) {
    console.log(`Halted on quota_exceeded this run: ${haltedProviders.join(', ')} (their remaining cells were skipped, not retried)`);
  }
}

function cmdHelp() {
  console.log(`
QUORUM - trust-aware AI execution router (build in progress)

Usage: quorum <command> [args]

Commands:
  test              Run every package's test suite (align, sign, registry,
                     stake, dispatch) and print a PASS/FAIL summary per
                     package plus a total.
  bench [--raw]     Run the real corruption benchmark (bench/run.js) against
                     the labelled corpus and print precision / recall /
                     false-positive rate. --raw scores document-granularity
                     text instead of curated focus spans.
  campaign          Run the Phase 3 degradation-measurement campaign
                     (bench/degradation/) for real, against every provider
                     with a credential env var present (ANTHROPIC_API_KEY,
                     OPENAI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY,
                     GEMINI_API_KEY/GOOGLE_API_KEY, OPENROUTER_API_KEY).
                     Providers with no key are skipped, not fatal. Prints a
                     clear message and does nothing else if none are set.
  --help, help      Show this message.

This CLI does not yet run the merge/routing pipeline end to end - that is
later build-plan work. It exists so the repo is runnable as one project.
`);
}

const cmd = process.argv[2];

switch (cmd) {
  case 'test':
    cmdTest();
    break;
  case 'bench':
    cmdBench();
    break;
  case 'campaign':
    await cmdCampaign();
    break;
  case '--help':
  case '-h':
  case 'help':
  case undefined:
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('');
    cmdHelp();
    process.exitCode = 1;
}
