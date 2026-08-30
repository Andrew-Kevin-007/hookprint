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
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

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

test('saveSession writes the session file at mode 0600', async () => {
  cleanup();
  await saveSession({ sessionToken: 'tok_mode1', walletAddress: '0xMODE1', expiresAt: '2026-09-13T00:00:00.000Z' });

  if (platform() === 'win32') {
    // Node's `mode` support on win32 does not map to POSIX permission bits
    // or a real ACL -- statSync(...).mode there is not meaningful evidence
    // of who can actually read the file, so this test can only confirm the
    // file was written, not that access is restricted. See the HONEST
    // LIMITATION comment in bin/lib/auth.js's saveSessionToFile() for why
    // that gap is left undefended on this platform rather than silently
    // assumed away.
    assert.ok(existsSync(FILE_PATH));
    cleanup();
    return;
  }

  const mode = statSync(FILE_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `expected file mode 0600, got 0${mode.toString(8)}`);
  cleanup();
});

test('saveSession corrects the mode of a pre-existing, looser-permissioned session file', async () => {
  cleanup();

  if (platform() === 'win32') {
    // Same limitation as above -- chmodSync on win32 does not restrict real
    // access, so there is nothing meaningful to assert here on this
    // platform. Documented rather than silently skipped.
    return;
  }

  // Simulate a leftover/pre-created file at a looser mode -- writeFileSync's
  // `mode` option only applies on file CREATION, so without the chmodSync
  // fix in saveSessionToFile() this file would keep its original 0644 mode
  // straight through the write below.
  mkdirSync(dirname(FILE_PATH), { recursive: true });
  writeFileSync(FILE_PATH, '{}', { mode: 0o644 });
  assert.equal(statSync(FILE_PATH).mode & 0o777, 0o644, 'test setup: file should start at 0644');

  await saveSession({ sessionToken: 'tok_mode2', walletAddress: '0xMODE2', expiresAt: '2026-09-13T00:00:00.000Z' });

  const mode = statSync(FILE_PATH).mode & 0o777;
  assert.equal(mode, 0o600, `expected saveSession to correct the mode to 0600, got 0${mode.toString(8)}`);
  cleanup();
});
