/**
 * run-exitcode.test.js — `quorum run`'s exit-code contract on the paths
 * that never reach a merge/verify decision at all.
 *
 * a78785a made `quorum run` exit non-zero when it produces an untrustworthy
 * RESULT (merge status not CLEAN, a failed batch, or a signature that fails
 * verifyExecutionTrace()) -- but that check only runs once a task has
 * actually been routed and executed. This file covers the two paths that
 * return BEFORE that point, which had no coverage at all: zero configured
 * provider credentials (found live, by deliberately emptying every provider
 * env var before this test existed -- see the comment at the fix site in
 * bin/quorum.js's cmdRun()), and the pre-existing missing-argument usage
 * error (kept here as a regression guard, not a new fix).
 *
 * Spawns the real CLI as a subprocess -- cmdRun() is a large, non-exported
 * function with no unit-testable seam for its early-return branches, so an
 * end-to-end process invocation is the only way to observe process.exitCode
 * from outside.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'quorum.js');

/**
 * Every env var bin/lib/providers.js's PROVIDER_ENV_VARS checks, forced to
 * an empty string so this test is deterministic on a machine that DOES have
 * a real repo-root .env with real keys (like the one this was written on) --
 * bin/quorum.js's `process.loadEnvFile(ENV_FILE)` follows Node's documented
 * --env-file precedence: an env var already present in the environment
 * (even set to '', which is what spawnSync's `env` does here) is never
 * overwritten by the file. SUPABASE_URL/KEY are cleared too so a real
 * mirror write is never attempted by a test.
 */
const NO_PROVIDER_ENV = {
  ...process.env,
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  GROQ_API_KEY: '',
  CEREBRAS_API_KEY: '',
  GEMINI_API_KEY: '',
  GOOGLE_API_KEY: '',
  OPENROUTER_API_KEY: '',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: ''
};

test('quorum run with zero configured provider credentials does no work and must not exit 0', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, 'run', 'a task with no providers configured'], {
    env: NO_PROVIDER_ENV,
    encoding: 'utf8'
  });

  assert.match(result.stdout, /no provider credentials found/);
  assert.notEqual(
    result.status,
    0,
    `a run that executed no task at all must not report success (exit 0); got status=${result.status}, stdout=${result.stdout}`
  );
});

test('quorum run with no task argument and no --file prints usage and exits 1', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, 'run'], {
    env: NO_PROVIDER_ENV,
    encoding: 'utf8'
  });

  assert.match(result.stderr, /Usage: quorum run/);
  assert.equal(result.status, 1);
});
