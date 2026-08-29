/**
 * BATON — swarm/test/run-cli.test.js
 *
 * Regression test for a real bug found while verifying run.js by hand: with
 * NO Anthropic credential configured at all, the SDK never reaches the
 * network — it throws a plain `Error` at header-build time ("Could not
 * resolve authentication method..."), which is NOT an `instanceof
 * Anthropic.AuthenticationError` (that class wraps an actual HTTP 401
 * response, and there was no HTTP response here). The original catch block
 * only checked `instanceof Anthropic.AuthenticationError`, so this exact
 * case fell through to the generic branch and printed a raw SDK stack trace
 * instead of the intended guidance. Fixed in run.js by also matching the
 * message. This test spawns the real CLI (no mocking) with credentials
 * stripped from its environment and asserts the fix holds.
 *
 * This test makes no network call — the failure it exercises happens before
 * any request is sent, which is also what makes it fast and safe to run
 * with no ANTHROPIC_API_KEY set, in any environment (including CI).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runJs = path.join(here, '..', 'run.js');

test('run.js with no credential configured prints guidance, not a raw stack trace, and exits non-zero', () => {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_FEDERATION_RULE_ID;
  delete env.ANTHROPIC_ORGANIZATION_ID;

  let output = '';
  let exitCode = 0;
  try {
    output = execFileSync('node', [runJs, '--runs', '3'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    // execFileSync throws on non-zero exit; the output is still on the error object.
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    exitCode = err.status ?? 1;
  }

  assert.notEqual(exitCode, 0, 'CLI should exit non-zero when no credential is configured');
  assert.match(output, /Authentication failed/i, 'should print the friendly auth-failure message');
  assert.match(output, /ANTHROPIC_API_KEY/, 'should name the env var to set');
  assert.doesNotMatch(output, /at Anthropic\.(validateHeaders|buildHeaders|buildRequest|makeRequest)/, 'must not leak a raw SDK stack trace to the user');
  assert.doesNotMatch(output, /run-02|run-03/, 'must stop after the first run rather than burning two more guaranteed-failing calls');
});
