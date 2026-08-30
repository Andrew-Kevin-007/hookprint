/**
 * auth.test.js — local session storage round-trip.
 *
 * Forces QUORUM_SESSION_BACKEND=file (see bin/lib/auth.js) so this test
 * exercises the real file-fallback code path deterministically, without
 * touching the developer's actual OS keychain. Set before the dynamic
 * import below so auth.js's per-call `forcedFileBackend()` check (read at
 * call time, not at module load) sees it for every saveSession/loadSession/
 * clearSession call in this file.
 */

process.env.QUORUM_SESSION_BACKEND = 'file';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { saveSession, loadSession, clearSession } from '../lib/auth.js';

/** Mirrors bin/lib/auth.js's sessionFilePath() so the test can assert on / clean up the real file. */
function sessionFilePath() {
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'quorum', 'session.json');
  }
  return join(homedir(), '.quorum', 'session.json');
}

const FILE_PATH = sessionFilePath();

function cleanup() {
  if (existsSync(FILE_PATH)) rmSync(FILE_PATH);
}

test('loadSession returns null when no session has ever been saved', async () => {
  cleanup();
  const session = await loadSession();
  assert.equal(session, null);
});

test('saveSession -> loadSession round-trips via the file fallback', async () => {
  cleanup();
  const written = { sessionToken: 'tok_abc123', walletAddress: '0xDEADBEEF', expiresAt: '2026-09-13T00:00:00.000Z' };

  await saveSession(written);
  assert.ok(existsSync(FILE_PATH), 'session file should exist on disk after saveSession');

  const read = await loadSession();
  assert.deepEqual(read, written);

  cleanup();
});

test('clearSession removes the persisted session, and it stays gone', async () => {
  cleanup();
  await saveSession({ sessionToken: 'tok_xyz', walletAddress: '0xFEED', expiresAt: '2026-09-13T00:00:00.000Z' });
  assert.ok(existsSync(FILE_PATH));

  await clearSession();
  assert.equal(existsSync(FILE_PATH), false, 'clearSession should delete the session file');

  const read = await loadSession();
  assert.equal(read, null);
});

test('clearSession on an already-empty session is a safe no-op', async () => {
  cleanup();
  await assert.doesNotReject(clearSession());
  assert.equal(await loadSession(), null);
});
