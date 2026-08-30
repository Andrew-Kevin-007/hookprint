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

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { PROVIDER_ENV_VARS, findAvailableProviders } from './lib/providers.js';
import { Spinner, renderWelcome } from './lib/ui.js';
import {
  batchAttemptLabel,
  batchFailureLine,
  batchSuccessLine,
  renderExecuteStageHeader,
  renderIntakeStage,
  renderMergeStage,
  renderPredictStage,
  renderProfileStage,
  renderRouteStage,
  renderVerifyStage
} from './lib/runView.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Where `quorum run` keeps its local ledger.
 *
 * NOT under ROOT. ROOT is wherever this CLI is *installed*, which for a
 * global `npm i -g` is a system directory (Program Files on Windows,
 * /usr/local/lib on macOS/Linux). Writing a per-user data file into the
 * package's own install directory works only by accident when you run from
 * a git clone, and fails outright on any locked-down install -- which would
 * take `quorum run` down with it, since the local ledger write is the one
 * write that is deliberately NOT swallowed (see appendDual: a failed
 * Supabase mirror is survivable, losing the local record is not).
 *
 * Mirrors bin/lib/auth.js's own sessionFilePath() exactly -- same platform
 * split, same `quorum` directory name -- so a user's CLI state all lives in
 * one predictable place per platform rather than two different ones.
 */
function localLedgerPath() {
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'quorum', 'run-ledger.jsonl');
  }
  return join(homedir(), '.quorum', 'run-ledger.jsonl');
}

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

/**
 * Runs one package's test command and resolves to the exact same shape
 * `spawnSync` used to produce here (`{...pkg, output, passed}`) — same
 * command/args/cwd/shell, same stdout+stderr concatenation, same pass rule
 * (`exit code 0`). The only reason this is `spawn` (async) instead of
 * `spawnSync` is so the event loop stays free to animate `cmdTest()`'s
 * spinner while a suite runs; `spawnSync` blocks Node's single thread
 * entirely, so no timer-driven animation could ever tick during it.
 */
function runPackageTests(pkg) {
  return new Promise((resolve) => {
    const cwd = join(ROOT, pkg.cwd);
    const child = spawn(pkg.command, pkg.args, { cwd, shell: pkg.shell ?? false });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => {
      resolve({ ...pkg, output: `${stdout}${stderr}`, passed: false });
    });
    child.on('close', (status) => {
      resolve({ ...pkg, output: `${stdout}${stderr}`, passed: status === 0 });
    });
  });
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

/**
 * In a real TTY this shows a live spinner per package while its suite runs
 * (`quorum test`'s five suites take ~30s total with zero output otherwise);
 * in PLAIN_MODE (piped/non-TTY, or NO_COLOR) the spinner is a no-op and the
 * printed lines are byte-identical to before this file grew a UI layer —
 * see `quorum test | cat`.
 */
async function cmdTest() {
  console.log('QUORUM - running every package test suite');
  console.log('');
  const results = [];
  for (const pkg of PACKAGES) {
    const spinner = new Spinner(`${pkg.name.padEnd(10)} running tests...`).start();
    // eslint-disable-next-line no-await-in-loop -- packages run sequentially, same order as before
    const r = await runPackageTests(pkg);
    spinner.stop();
    const summary = summarize(r.output);
    console.log(`  ${pkg.name.padEnd(10)} ... ${r.passed ? 'PASS' : 'FAIL'}${summary ? `  (${summary} tests)` : ''}`);
    if (!r.passed) {
      console.log('');
      console.log(`--- ${pkg.name} output ---`);
      console.log(r.output.trim());
      console.log(`--- end ${pkg.name} ---`);
      console.log('');
    }
    results.push(r);
  }

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

/**
 * `quorum login` / `logout` / `whoami` — session management against the web
 * app's CLI-login handshake (see bin/lib/auth.js's header comment for the
 * exact route contract). Dynamically imported the same way cmdCampaign()
 * imports bench/degradation/*, since these three commands are the only ones
 * that need it.
 */
async function cmdLogin() {
  const { login } = await import(pathToFileURL(join(ROOT, 'bin', 'lib', 'auth.js')));
  await login();
}

async function cmdLogout() {
  const { logout } = await import(pathToFileURL(join(ROOT, 'bin', 'lib', 'auth.js')));
  await logout();
}

async function cmdWhoami() {
  const { whoami } = await import(pathToFileURL(join(ROOT, 'bin', 'lib', 'auth.js')));
  await whoami();
}

/**
 * Turn a bare task string, or a --file's content, into route-contracts.js
 * `buildTaskRequest()`'s `items[]` shape. A bare description becomes ONE
 * item (the common case: `quorum run "<task description>"`). A file's
 * content is split on blank lines into paragraphs, each its own item, so a
 * multi-paragraph document produces a real multi-batch task — falling back
 * to the whole file as one item if it has no blank-line breaks at all.
 */
function buildItemsFromArg(taskArg, fileContent) {
  if (fileContent != null) {
    const paragraphs = fileContent
      .split(/\r?\n\s*\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const list = paragraphs.length > 0 ? paragraphs : [fileContent.trim()];
    return list.map((content, idx) => ({ id: `item-${idx + 1}`, content }));
  }
  return [{ id: 'item-1', content: taskArg }];
}

/**
 * `quorum run "<task description>"` / `quorum run --file <path>` — run ONE
 * real task through the actual dispatch pipeline end to end, against
 * whichever providers actually have credentials in `.env` (the same
 * `PROVIDER_ENV_VARS` gating `cmdCampaign()` already uses), recording real
 * ledger events locally and, when SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are
 * set, mirroring them to Supabase for the live dashboard
 * (`kevin_frontend`'s `GET /api/dashboard/snapshot`, a separate repo).
 *
 * This wires together ALREADY-TESTED pieces — `dispatcher/policy.js`'s
 * `decideRoute()`/`decideFallback()`, `executor/index.js`'s `executeBatch()`/
 * `buildExecutionLedgerEvent()`, `merge/index.js`'s `mergeRoute()`,
 * `quality/score.js`'s `buildQualityScoreEvent()`, `trace/index.js`'s
 * `assembleExecutionTrace()`/`signExecutionTrace()`/`verifyExecutionTrace()`
 * — in the same order `tests/e2e.test.js` already proves works. No new
 * routing/scoring/merge logic is written here.
 *
 * PROVIDER SELECTION: `decideRoute()`'s reputation/quota machinery (steps
 * 1-3, PRODUCT-ARCHITECTURE.md Layer 3) needs either real agent predictions
 * or a configured `totalQuota` per provider — neither exists for a bare CLI
 * run with no external agent submitting a prediction. Rather than fabricate
 * either, this uses `decideRoute()`'s OPERATOR-OVERRIDE path
 * (`options.operatorOverride`) — the real, tested, intended code path for
 * exactly this situation: an operator (the person running `quorum run`) is
 * explicitly choosing a provider, not an automated agent predicting one.
 * The provider chosen is the top-ranked FUNDED provider per
 * `provider-profiles.js`'s real `rankProviders()` — a real ranking, not an
 * arbitrary pick. `decideRoute()` still runs its real
 * `buildOverrideDecision()` path (batch planning, fallback-chain ranking,
 * ledger logging of the thin 'task-routed' event) unchanged.
 *
 * LEDGER EVENTS WRITTEN (local always; Supabase-mirrored when configured):
 *   'task-routed'              — written automatically by decideRoute()'s
 *                                 own logRouteDecision() (thin payload, NOT
 *                                 mirrored to Supabase — see supabase-store.js
 *                                 header; the dashboard reads the richer
 *                                 'route-decision-recorded' event below).
 *   'route-decision-recorded'  — payload = dispatcher/policy.js's
 *                                 toDashboardEntry(decision), pure reuse.
 *   'task-completed'/'task-failed' (per batch) — buildExecutionLedgerEvent().
 *   'batch-quality-scored' (per successfully-parsed batch) — built via
 *                                 quality/score.js's buildQualityScoreEvent()
 *                                 directly (NOT via mergeRoute()'s own
 *                                 options.ledgerPath — that would only write
 *                                 locally, with no way to also mirror to
 *                                 Supabase without a double local write; see
 *                                 inline comment at the call site below).
 *   'merge-completed'/'merge-contradiction-found'/'merge-incomplete' —
 *                                 merge/index.js's buildMergeLedgerEvent().
 *   'execution-trace-recorded' — the new Phase 7 event type (see
 *                                 execution-contracts.js), payload built from
 *                                 the real signed trace + a
 *                                 buildDashboardSnapshot() call for its
 *                                 already-implemented meanOutcomeAccuracy
 *                                 math (zero duplicated logic).
 */
async function cmdRun() {
  const args = process.argv.slice(3);
  let taskArg = null;
  let filePath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--file') {
      filePath = args[i + 1];
      i += 1;
    } else if (taskArg === null) {
      taskArg = args[i];
    }
  }

  if (!taskArg && !filePath) {
    console.error('Usage: quorum run "<task description>"  |  quorum run --file <path>');
    process.exitCode = 1;
    return;
  }

  const availableProviders = findAvailableProviders();
  if (availableProviders.length === 0) {
    console.log('no provider credentials found; quorum run needs at least one provider API key in .env (see `quorum campaign` for the full list of expected env vars)');
    return;
  }

  const { readFileSync } = await import('node:fs');
  const fileContent = filePath ? readFileSync(filePath, 'utf8') : null;

  const [
    { buildTaskRequest, analyzeTaskQuality },
    { decideRoute, decideFallback, toDashboardEntry },
    { MODEL_PROFILES, rankProviders },
    { executeBatch, buildPromptFromBatch, buildExecutionLedgerEvent },
    { buildEnvelopePrompt },
    { mergeRoute, buildMergeLedgerEvent },
    { buildQualityScoreEvent },
    { compareOutcome },
    { assembleExecutionTrace, signExecutionTrace, verifyExecutionTrace },
    { predictQuality },
    { learnedCurveLookup },
    { appendEvent },
    { createLedgerEvent, buildDashboardSnapshot },
    { generateIdentity },
    { maybeCreateSupabaseLedgerStore }
  ] = await Promise.all([
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'route-contracts.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'dispatcher', 'policy.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'provider-profiles.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'executor', 'index.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'executor', 'envelope.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'merge', 'index.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'quality', 'score.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'trace', 'outcome.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'trace', 'index.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'profiling', 'predict.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'ledger', 'curves.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'ledger', 'store.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'execution-contracts.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'sign', 'index.js'))),
    import(pathToFileURL(join(ROOT, 'packages', 'dispatch', 'ledger', 'supabase-store.js')))
  ]);

  const ledgerPath = localLedgerPath();
  const supabaseStore = maybeCreateSupabaseLedgerStore();

  /** Write one event to the local ledger (always) and the Supabase mirror
   * (when configured) — a failed mirror write is logged and swallowed, never
   * aborting a real local run (see supabase-store.js's own header).
   *
   * The local write is deliberately NOT swallowed the same way: the ledger
   * is the record the dashboard, the learned degradation curves and the
   * signed trace all read back, so silently losing it would leave a run
   * looking successful while its evidence went nowhere. It is wrapped only
   * to turn an unhelpful raw ENOENT/EACCES stack trace into a message that
   * names the actual path and the actual cause, then still fails. */
  async function appendDual(event) {
    try {
      appendEvent(ledgerPath, event);
    } catch (err) {
      throw new Error(
        `could not write the local ledger at ${ledgerPath}: ${err.message}\n` +
        `  This is where quorum keeps each run's record. Check the directory is writable.`
      );
    }
    if (supabaseStore) {
      try {
        await supabaseStore.appendEvent(event);
      } catch (err) {
        console.error(`  [supabase] mirror write failed for ${event.eventType}: ${err.message}`);
      }
    }
  }

  const items = buildItemsFromArg(taskArg, fileContent);
  const taskId = `task-run-${Date.now()}`;
  const task = buildTaskRequest({ taskId, kind: 'document-analysis', items, qualityTarget: 0 });

  console.log(renderIntakeStage({ taskId, itemCount: items.length, availableProviders }));

  const analysis = analyzeTaskQuality(task);
  const workloadClassification = { workloadType: analysis.prediction.workloadType, confidence: analysis.prediction.workloadConfidence };
  console.log(renderProfileStage({
    workloadType: workloadClassification.workloadType,
    confidence: workloadClassification.confidence,
    signals: analysis.prediction.workloadSignals
  }));

  const fundedProviderList = availableProviders.map((name) => MODEL_PROFILES[name]).filter(Boolean);
  const ranked = rankProviders(task, fundedProviderList, { ledgerPath });
  const topProvider = ranked[0]?.provider ?? availableProviders[0];
  console.log(renderPredictStage({ ranked, topProvider }));

  const decision = decideRoute(task, {
    providerList: fundedProviderList,
    ledgerPath,
    operatorOverride: { provider: topProvider, reason: 'quorum-run-cli: top-ranked funded provider' }
  });

  if (!decision.approved) {
    console.error(`route rejected: ${decision.reason}`);
    return;
  }
  console.log(renderRouteStage({ decision }));

  await appendDual(createLedgerEvent({
    eventType: 'route-decision-recorded',
    taskId,
    provider: decision.primaryProvider,
    routeId: decision.decisionId,
    payload: toDashboardEntry(decision)
  }));

  const batchDefs = decision.batchPlan.map((bp) => ({
    batchIndex: bp.batchIndex,
    items: bp.itemIds.map((id) => task.items.find((it) => it.id === id)).filter(Boolean)
  }));

  const buildPrompt = (rd, batch) => buildEnvelopePrompt(buildPromptFromBatch(rd, batch), { kind: task.kind });

  console.log(renderExecuteStageHeader({ batchCount: batchDefs.length }));

  const batchResults = [];
  for (const [batchPosition, bd] of batchDefs.entries()) {
    let providerName = decision.primaryProvider;
    const attempted = [];
    let outcome;
    const spinner = new Spinner(batchAttemptLabel({ batchIndex: bd.batchIndex, batchPosition: batchPosition + 1, batchCount: batchDefs.length, providerName })).start();

    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- one batch's retry chain is inherently sequential
      outcome = await executeBatch(decision, bd.items, { providerName, buildPrompt });
      attempted.push(providerName);

      if (outcome.status === 'success') {
        spinner.succeed(batchSuccessLine({ batchIndex: bd.batchIndex, providerName, outcome }));
        break;
      }

      const fb = decideFallback(decision, outcome, attempted);
      spinner.fail(batchFailureLine({ batchIndex: bd.batchIndex, providerName, outcome, fallback: fb }));
      if (!fb.retry || !fb.nextProvider) break;
      providerName = fb.nextProvider;
      spinner.update(batchAttemptLabel({ batchIndex: bd.batchIndex, batchPosition: batchPosition + 1, batchCount: batchDefs.length, providerName })).start();
    }

    // eslint-disable-next-line no-await-in-loop
    await appendDual(buildExecutionLedgerEvent(decision, outcome, { batchIndex: bd.batchIndex, taskId, provider: providerName }));

    const providerProfile = MODEL_PROFILES[providerName] ?? MODEL_PROFILES[decision.primaryProvider];
    const contextRatio = providerProfile ? (providerProfile.tokensPerItem * bd.items.length) / providerProfile.contextWindow : null;

    batchResults.push({ provider: providerName, batchIndex: bd.batchIndex, outcome, batch: bd.items, contextRatio });
  }

  // predictQuality() BEFORE reading mergeRoute()'s scores, so outcomeComparisons
  // below compares a real prediction against a real measured outcome -- same
  // ordering tests/e2e.test.js proves works.
  const predictions = batchDefs.map((bd) => {
    const br = batchResults.find((b) => b.batchIndex === bd.batchIndex);
    const providerProfile = MODEL_PROFILES[br.provider] ?? MODEL_PROFILES[decision.primaryProvider];
    return { batchIndex: bd.batchIndex, prediction: predictQuality(task, providerProfile, workloadClassification, bd.items.length, learnedCurveLookup(ledgerPath)) };
  });

  // mergeRoute() called WITHOUT options.ledgerPath -- pure, no I/O (see its
  // own file header: this is its documented no-ledgerPath default). Ledger
  // writes for 'batch-quality-scored' are done explicitly below instead, via
  // the same real buildQualityScoreEvent() mergeRoute() would have called
  // internally -- this is what lets appendDual() mirror them to Supabase too,
  // which mergeRoute()'s own internal appendEvent() call has no way to do.
  const mergeResult = mergeRoute(decision, batchResults, { taskId, workloadClassification });
  console.log(renderMergeStage({ mergeResult }));

  for (const qs of mergeResult.qualityScores) {
    const { provider, batchIndex, contextRatio, ...scoreResult } = qs;
    // eslint-disable-next-line no-await-in-loop
    await appendDual(buildQualityScoreEvent({
      taskId,
      provider,
      routeId: decision.decisionId,
      batchIndex,
      contextRatio,
      scoreResult,
      workloadType: workloadClassification.workloadType
    }));
  }

  await appendDual(buildMergeLedgerEvent(decision, mergeResult, { taskId }));

  const outcomeComparisons = mergeResult.qualityScores.map((qs) => {
    const pred = predictions.find((p) => p.batchIndex === qs.batchIndex)?.prediction;
    return compareOutcome(pred?.predictedQuality, qs.combinedScore);
  });

  const assembledAt = new Date().toISOString();
  const trace = assembleExecutionTrace({ task, workloadClassification, routeDecision: decision, batchResults, mergeResult, outcomeComparisons, assembledAt });

  const identity = generateIdentity();
  const signed = signExecutionTrace(trace, identity.privateKey, identity.publicKey);
  const verified = verifyExecutionTrace(signed);

  // Real reuse of buildDashboardSnapshot()'s own meanOutcomeAccuracy math --
  // execution-contracts.js's computeMeanOutcomeAccuracy() is private
  // (unexported), so this is how a caller outside that file gets the same
  // number without reimplementing it.
  const snapshotPreview = buildDashboardSnapshot({ executionTraces: [trace] });
  const meanOutcomeAccuracy = snapshotPreview.traces[0]?.meanOutcomeAccuracy ?? null;

  console.log(renderVerifyStage({ traceId: trace.traceId, meanOutcomeAccuracy, keyId: signed.attestation.keyId, verified }));

  await appendDual(createLedgerEvent({
    eventType: 'execution-trace-recorded',
    taskId,
    provider: decision.primaryProvider,
    routeId: decision.decisionId,
    payload: {
      traceId: trace.traceId,
      status: mergeResult.status,
      contradictionCount: mergeResult.verification.contradictions.length,
      agreementCount: mergeResult.verification.agreements.length,
      unmatchedCount: mergeResult.verification.unmatched.length,
      meanOutcomeAccuracy,
      assembledAt,
      attestation: signed.attestation,
      verified
    }
  }));

  console.log('');
  console.log(`Done. taskId=${taskId} traceId=${trace.traceId} verifyExecutionTrace()=${verified}`);
  console.log(`Local ledger: ${ledgerPath}`);
  console.log(supabaseStore ? 'Mirrored to Supabase: dispatch_ledger_events' : 'Supabase mirror disabled (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set)');

  // A run that did real work but produced an untrustworthy result must not
  // report success. Until now the ONLY exitCode=1 path in this function was
  // the missing-argument usage error, so `quorum run` exited 0 even when
  // every batch failed authentication and the merge came back INCOMPLETE --
  // meaning any CI job or shell script gating on `quorum run && deploy`
  // would have treated a total pipeline failure as a pass. Found by
  // deliberately forcing every provider to fail auth, not by reading code.
  //
  // The three real merge statuses come from merge/index.js:
  //   CLEAN                -- batches agreed, nothing outstanding
  //   CONTRADICTIONS_FOUND -- cross-batch check caught a real disagreement
  //   INCOMPLETE           -- at least one batch never produced a usable result
  //
  // CONTRADICTIONS_FOUND is deliberately a FAILURE exit here, not a warning.
  // Catching a contradiction is the product working exactly as intended, but
  // the answer it just produced is precisely the kind you must not ship
  // unreviewed -- that is the entire thesis. Exiting 0 on it would tell a
  // script "this output is fine to use", which is the opposite of true.
  //
  // `verified === false` means verifyExecutionTrace() rejected the signature
  // over the trace: the record of what happened cannot be trusted, whatever
  // the merge said.
  const untrustworthy =
    mergeResult.status !== 'CLEAN' ||
    mergeResult.failedBatches.length > 0 ||
    verified !== true;

  if (untrustworthy) {
    process.exitCode = 1;
  }
}

/**
 * Bare `quorum` (no args) — a welcome screen, not just help text: the
 * QUORUM name, a one-line statement of what it does, and REAL checked
 * status (provider keys found, Supabase dashboard mirror on/off, logged in
 * or not) plus a next-step nudge. No network call — `loadSession()` is a
 * local keychain/file read only (see bin/lib/auth.js), so this can never
 * hang waiting on the web app or a network connection.
 */
async function cmdWelcome() {
  const { loadSession } = await import(pathToFileURL(join(ROOT, 'bin', 'lib', 'auth.js')));
  const session = await loadSession();
  const availableProviders = findAvailableProviders();
  const missingProviders = Object.keys(PROVIDER_ENV_VARS).filter((p) => !availableProviders.includes(p));
  const supabaseConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  console.log(renderWelcome({
    availableProviders,
    missingProviders,
    supabaseConfigured,
    walletAddress: session?.walletAddress ?? null
  }));
}

/** `quorum init` — first-run setup: create `.env`, prompt for missing provider keys, offer to log in. See bin/lib/init.js for the full flow and its non-interactive (no-TTY) behaviour. */
async function cmdInit() {
  const { runInit } = await import(pathToFileURL(join(ROOT, 'bin', 'lib', 'init.js')));
  await runInit(ROOT);
}

function cmdHelp() {
  console.log(`
QUORUM - trust-aware AI execution router (build in progress)

Usage: quorum <command> [args]

Commands:
  (no command)      Show the welcome screen: what's configured, what isn't,
                     and what to run next.
  init              First-run setup: create .env, prompt for any missing
                     provider key, offer to log in.
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
  run <task>        Run ONE real task through the full dispatch pipeline
  run --file <path> (intake -> profile -> route -> execute -> merge -> score
                     -> sign -> verify) against whichever providers actually
                     have credentials in .env, recording real ledger events
                     locally (~/.quorum/run-ledger.jsonl, or %LOCALAPPDATA%\
                     quorum\ on Windows) and, if SUPABASE_URL /
                     SUPABASE_SERVICE_ROLE_KEY are set, mirroring them to
                     Supabase for the live dashboard.
  login             Log in via the browser (opens WEB_ORIGIN's login page,
                     polls for approval, then stores a session locally).
  logout            Revoke and clear the locally stored session.
  whoami            Print the wallet address of the current session, or
                     whether you're logged out / your session expired.
  --help, help      Show this message.
`);
}

const cmd = process.argv[2];

switch (cmd) {
  case 'test':
    await cmdTest();
    break;
  case 'bench':
    cmdBench();
    break;
  case 'campaign':
    await cmdCampaign();
    break;
  case 'run':
    await cmdRun();
    break;
  case 'init':
    await cmdInit();
    break;
  case 'login':
    await cmdLogin();
    break;
  case 'logout':
    await cmdLogout();
    break;
  case 'whoami':
    await cmdWhoami();
    break;
  case undefined:
    await cmdWelcome();
    break;
  case '--help':
  case '-h':
  case 'help':
    cmdHelp();
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.error('');
    cmdHelp();
    process.exitCode = 1;
}
