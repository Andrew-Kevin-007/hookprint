/**
 * run-exitcode-scenarios.test.js — `quorum run`'s exit-code contract on the
 * three untrustworthy-result branches that run-exitcode.test.js's own file
 * header says had zero coverage: mergeResult.status !== 'CLEAN'
 * (CONTRADICTIONS_FOUND), a non-empty failedBatches (INCOMPLETE), and
 * verified !== true.
 *
 * WHY A STUB IS NEEDED (see bin/quorum.js's stubBatchOutcomeForTest() for
 * the seam this drives): cmdRun() always calls the real provider adapter's
 * createClient()+call() when it isn't given a client, so reaching any of
 * these three branches for real requires either a live provider making a
 * real HTTP call that happens to return a genuinely bad/conflicting
 * response (flaky, costs a real request, needs network — unacceptable for
 * a test suite that must pass offline and deterministically) or a seam
 * inside cmdRun(), which had none until now. QUORUM_TEST_ONLY_SCENARIO is
 * that seam: it replaces ONLY the raw provider response inside cmdRun()'s
 * batch loop (and, for 'bad_signature' only, WHICH of two real ed25519
 * public keys gets attested) with a canned value. Every other real
 * function in the pipeline runs completely unmodified: decideRoute(),
 * decideFallback(), mergeRoute(), crossCheckBatches(),
 * buildQualityScoreEvent(), assembleExecutionTrace(), signExecutionTrace(),
 * verifyExecutionTrace().
 *
 * WHAT THIS PROVES: that cmdRun() correctly wires a real mergeRoute()/
 * verifyExecutionTrace() outcome into process.exitCode — for a merge
 * result that genuinely IS CONTRADICTIONS_FOUND / INCOMPLETE (produced by
 * the real crossCheckBatches()/parseEnvelope() logic acting on the stub's
 * output), and for an attestation that genuinely DOES fail real ed25519
 * verification (a real public-key mismatch, not a fabricated boolean).
 *
 * WHAT THIS DOES NOT PROVE: that a real provider SDK/HTTP call can produce
 * a conflicting or failed response in production — that is a property of
 * the providers and packages/dispatch/executor/*.js, not of cmdRun()'s
 * exit-code wiring, and is out of scope here (see packages/dispatch/tests/
 * for merge/consistency/envelope unit coverage of that underlying logic).
 *
 * LEDGER ISOLATION: bin/quorum.js's localLedgerPath() reads
 * process.env.LOCALAPPDATA on Windows (home-dir-based on other platforms —
 * not overridden here since this suite only needs to run on this repo's
 * Windows dev/CI environment). Every test below points LOCALAPPDATA at a
 * fresh temp directory so a real `quorum run` through cmdRun()'s full
 * pipeline never appends a stub-scenario event to the machine's actual
 * ~/.quorum (or %LOCALAPPDATA%\quorum) ledger — which learnedCurveLookup()
 * later reads to shape REAL routing decisions. Skipping this isolation
 * would be a genuine production-data side effect from running the test
 * suite, not just test hygiene.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'quorum.js');

/**
 * Exactly one funded provider — cerebras, whose MODEL_PROFILES entry has
 * the smallest maxBatchSize (16) of the six real adapters, so the fewest
 * items are needed to force >1 batch. The key value is never used for a
 * real request in these tests (QUORUM_TEST_ONLY_SCENARIO short-circuits
 * before any adapter.createClient()/call() runs) — it only needs to be
 * non-empty so findAvailableProviders() reports cerebras as configured.
 * `localAppData` isolates the local ledger write — see file header.
 */
function scenarioEnv(scenario, localAppData) {
  return {
    ...process.env,
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    GROQ_API_KEY: '',
    CEREBRAS_API_KEY: 'test-stub-key',
    GEMINI_API_KEY: '',
    GOOGLE_API_KEY: '',
    OPENROUTER_API_KEY: '',
    SUPABASE_URL: '',
    SUPABASE_SERVICE_ROLE_KEY: '',
    QUORUM_TEST_ONLY_SCENARIO: scenario,
    LOCALAPPDATA: localAppData
  };
}

/**
 * 17 blank-line-separated paragraphs — one more than cerebras's
 * maxBatchSize (16), so route-contracts.js's planBatches() is forced to
 * split into 2 real batches (16 items + 1 item), which is what makes a
 * cross-batch contradiction/failure possible at all (merge/consistency.js's
 * crossCheckBatches() only ever compares claims from two DIFFERENT
 * (provider, batchIndex) sources — verified live against estimateProviderFit()
 * before writing this test). Content is never sent anywhere real —
 * QUORUM_TEST_ONLY_SCENARIO replaces the batch's response before any
 * prompt is built from it.
 */
function multiBatchFile(dir) {
  const path = join(dir, 'multi-batch-task.txt');
  const paragraphs = Array.from({ length: 17 }, (_, i) => `stub item ${i + 1}`);
  writeFileSync(path, paragraphs.join('\n\n'), 'utf8');
  return path;
}

test('quorum run: a real CONTRADICTIONS_FOUND merge must not exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-test-'));
  try {
    const file = multiBatchFile(dir);
    const result = spawnSync(process.execPath, [CLI_PATH, 'run', '--file', file], {
      env: scenarioEnv('contradiction', join(dir, 'appdata')),
      encoding: 'utf8'
    });

    assert.match(result.stdout, /status: CONTRADICTIONS_FOUND/, `expected a real CONTRADICTIONS_FOUND merge; stdout=${result.stdout}`);
    assert.notEqual(result.status, 0, `a run whose merge caught a real contradiction must not report success (exit 0); got status=${result.status}, stdout=${result.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quorum run: a real failed batch (INCOMPLETE merge) must not exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-test-'));
  try {
    const file = multiBatchFile(dir);
    const result = spawnSync(process.execPath, [CLI_PATH, 'run', '--file', file], {
      env: scenarioEnv('failed_batch', join(dir, 'appdata')),
      encoding: 'utf8'
    });

    assert.match(result.stdout, /status: INCOMPLETE/, `expected a real INCOMPLETE merge from a failed batch; stdout=${result.stdout}`);
    assert.notEqual(result.status, 0, `a run with a real failed batch must not report success (exit 0); got status=${result.status}, stdout=${result.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quorum run: a signature that fails real verifyExecutionTrace() must not exit 0', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-test-'));
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, 'run', 'single item task'], {
      env: scenarioEnv('bad_signature', join(dir, 'appdata')),
      encoding: 'utf8'
    });

    assert.match(result.stdout, /status: CLEAN/, `merge itself should still be CLEAN in this scenario — only the attestation is deliberately mismatched; stdout=${result.stdout}`);
    assert.match(result.stdout, /verifyExecutionTrace\(\) = false/, `expected a real ed25519 verification failure from a genuine public-key mismatch; stdout=${result.stdout}`);
    assert.notEqual(result.status, 0, `a run whose signed trace fails real verification must not report success (exit 0); got status=${result.status}, stdout=${result.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('quorum run: a clean run with a genuinely matching signature exits 0 (control case)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-test-'));
  try {
    const result = spawnSync(process.execPath, [CLI_PATH, 'run', 'single item task'], {
      env: scenarioEnv('clean', join(dir, 'appdata')),
      encoding: 'utf8'
    });

    assert.match(result.stdout, /status: CLEAN/, `stdout=${result.stdout}`);
    assert.match(result.stdout, /verifyExecutionTrace\(\) = true/, `stdout=${result.stdout}`);
    assert.equal(result.status, 0, `a genuinely clean, verified run must exit 0 — this control case proves the check does not false-positive on a good run; got status=${result.status}, stdout=${result.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
