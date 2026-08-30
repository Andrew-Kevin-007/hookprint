/**
 * bin/lib/auth.js — QUORUM CLI auth: login / logout / whoami.
 *
 * Talks to the web app's CLI-login handshake and session routes (see
 * `.env.example` for `WEB_ORIGIN`). This file owns nothing server-side — it
 * is purely the CLI half of a contract a parallel web app implements:
 *
 *   POST {WEB_ORIGIN}/api/cli/login/start                -> { requestId, state, loginUrl }
 *   GET  {WEB_ORIGIN}/api/cli/login/poll?requestId&state  -> { status: 'pending' | 'approved' | 'expired', exchangeCode? }
 *   POST {WEB_ORIGIN}/api/cli/login/exchange              -> { sessionToken, walletAddress, expiresAt }
 *   POST {WEB_ORIGIN}/api/auth/logout                     -> best-effort server-side revoke
 *   GET  {WEB_ORIGIN}/api/auth/session                    -> re-validate a stored session
 *
 * ASSUMPTION TO VERIFY once the web side lands: `/api/auth/logout` and
 * `/api/auth/session` are called here with `Authorization: Bearer <token>`.
 * That was not independently confirmed against the other agent's route
 * handlers — if they expect the session as a cookie instead, this is the
 * one integration point to fix.
 */

import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const WEB_ORIGIN = process.env.WEB_ORIGIN || 'http://localhost:3000';
const KEYRING_SERVICE = 'quorum-cli';
const KEYRING_ACCOUNT = 'session';
const POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — matches the server-side login-request expiry

/* -------------------------------------------------------------------------- */
/* Local session storage                                                      */
/*                                                                              */
/* Two tiers: the OS keychain (via @napi-rs/keyring) first, falling back to a  */
/* plain file only when the keychain genuinely fails — e.g. headless Linux     */
/* with no Secret Service daemon running.                                      */
/*                                                                              */
/* HONEST LIMITATION: neither tier defeats malware running as the same OS      */
/* user — both the keychain entry and the fallback file are readable by        */
/* anything with your account's own privileges. This is not an unbreakable     */
/* vault. The real mitigation is server-side: sessions expire after 14 days,   */
/* and both `quorum logout` and a web "sign out all devices" button revoke a   */
/* session immediately regardless of where (or whether) a local copy sits.     */
/*                                                                              */
/* QUORUM_SESSION_BACKEND=file forces the file path and skips the keychain     */
/* entirely — used by bin/test/auth.test.js to exercise the fallback           */
/* deterministically without touching the real OS keychain, and useful on a    */
/* real machine where the keychain daemon is known to be unavailable.          */
/* -------------------------------------------------------------------------- */

function forcedFileBackend() {
  return process.env.QUORUM_SESSION_BACKEND === 'file';
}

function sessionFilePath() {
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'quorum', 'session.json');
  }
  return join(homedir(), '.quorum', 'session.json');
}

function saveSessionToFile(session) {
  const filePath = sessionFilePath();
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, JSON.stringify(session), { mode: 0o600 });

  // `writeFileSync`'s `mode` option is only applied when the file is
  // CREATED — if session.json already existed (leftover from a prior
  // version, or pre-created by a local attacker with looser permissions so
  // the write above lands on their existing, laxer file), the write just
  // happens at whatever mode the file already had, with no correction.
  // chmodSync closes that gap explicitly on every save, not just the first.
  //
  // HONEST LIMITATION: on Windows this call is close to a no-op for
  // confidentiality. POSIX mode bits don't map to real ACLs there — Node's
  // `mode`/`chmodSync` on win32 can at most toggle the read-only attribute,
  // not restrict which other Windows accounts can read the file. Real
  // per-user confidentiality on Windows would need actual ACL manipulation
  // (icacls / SetNamedSecurityInfo), which is out of scope here. This file
  // still relies on the same server-side mitigation described above
  // (sessions expire, and are revocable from the web) rather than the local
  // file being a real vault on that platform.
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
}

function loadSessionFromFile() {
  const filePath = sessionFilePath();
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null; // corrupt/partial file — treat as "no session" rather than crash
  }
}

function clearSessionFromFile() {
  const filePath = sessionFilePath();
  if (!existsSync(filePath)) return;
  try {
    unlinkSync(filePath);
  } catch {
    // best-effort — nothing more we can do locally
  }
}

async function keyringSet(payload) {
  const { Entry } = await import('@napi-rs/keyring');
  new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT).setPassword(payload);
}

async function keyringGet() {
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT).getPassword();
}

async function keyringClear() {
  const { Entry } = await import('@napi-rs/keyring');
  new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT).deletePassword();
}

/** Persist a session. Tries the OS keychain first, falls through to the file on any failure. */
export async function saveSession(session) {
  const payload = JSON.stringify(session);
  if (!forcedFileBackend()) {
    try {
      await keyringSet(payload);
      return;
    } catch {
      // no keychain daemon, no prebuilt binary for this platform, etc. — fall through
    }
  }
  saveSessionToFile(session);
}

/**
 * Read the local session, if any. Always falls back to the file path too
 * (even when the keychain itself works but has no entry) so a session saved
 * under one tier is still found if the other tier was used at save time.
 */
export async function loadSession() {
  if (!forcedFileBackend()) {
    try {
      const raw = await keyringGet();
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to file
    }
  }
  return loadSessionFromFile();
}

/** Clear the local session from both tiers. Never throws — logout must always succeed locally. */
export async function clearSession() {
  if (!forcedFileBackend()) {
    try {
      await keyringClear();
    } catch {
      // nothing to clear there, or no keychain available — fine
    }
  }
  clearSessionFromFile();
}

/* -------------------------------------------------------------------------- */
/* Network helpers                                                            */
/* -------------------------------------------------------------------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turn a failed `fetch()` into a message a user can act on instead of a raw stack trace. */
function describeFetchError(err, origin) {
  const code = err?.cause?.code;
  if (code === 'ECONNREFUSED') {
    return `Could not reach ${origin} — connection refused. Is the QUORUM web app running? (WEB_ORIGIN=${origin})`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `Could not resolve host for ${origin}. Check the WEB_ORIGIN environment variable.`;
  }
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') {
    return `Connection to ${origin} was interrupted (${code}). Try again.`;
  }
  return `Could not reach ${origin}: ${err.message}`;
}

/**
 * Best-effort human-readable message from a non-2xx response: JSON
 * `{error}`/`{message}` when the body is actually JSON, else plain text
 * when the body looks like plain text, else just `HTTP {status}
 * {statusText}` — e.g. a 404 from a route that doesn't exist yet comes back
 * as an HTML page (Next.js's default 404), and dumping that HTML would be
 * just as unreadable as a raw stack trace.
 */
async function extractErrorMessage(res) {
  const contentType = res.headers.get('content-type') || '';
  const fallback = res.statusText ? `HTTP ${res.status} ${res.statusText}` : `HTTP ${res.status}`;

  if (contentType.includes('application/json')) {
    try {
      const body = await res.json();
      if (typeof body?.error === 'string') return body.error;
      if (typeof body?.message === 'string') return body.message;
    } catch {
      // malformed JSON body — fall through to the plain HTTP status
    }
    return fallback;
  }

  if (contentType.includes('text/plain')) {
    try {
      const text = (await res.text()).trim();
      if (text) return text.slice(0, 300);
    } catch {
      // fall through
    }
  }

  return fallback;
}

/**
 * Cross-platform "open a URL in the default browser," best-effort —
 * headless/SSH sessions rely on the printed URL instead.
 *
 * On Windows this deliberately does NOT do `spawn('start', [url], { shell:
 * true })` — `start` is a cmd.exe built-in (not its own .exe) so it needs a
 * shell either way, but `shell: true` hands the url straight to Node, which
 * warns (DEP0190) that it only concatenates args into the shell command
 * line rather than escaping them.
 *
 * An earlier version ran `cmd.exe /c start "" <url>` with shell:false to
 * avoid that DEP0190 concatenation, reasoning that Node's own argv escaping
 * (used when spawning a real executable directly, not through a shell)
 * would keep the url intact. That reasoning missed a second layer: `cmd.exe
 * /c` re-parses its ENTIRE trailing command line using cmd.exe's own
 * grammar, in which a bare `&` (outside quotes) is a command separator —
 * regardless of how Node quoted the argv it handed to CreateProcess. Every
 * CLI login URL contains `&` (it separates the `requestId` and `state`
 * query params), so cmd.exe silently split `start "" <url up to the &>`
 * from `state=<value>` and tried to run the latter as its own command,
 * which fails with "'state' is not recognized..." — swallowed by
 * `stdio: 'ignore'`, so the CLI reported "Opening your browser..." with no
 * error while only the truncated, state-less URL ever reached the browser.
 * Confirmed by direct repro on this exact code before changing it:
 * `spawn('cmd.exe', ['/c','echo','X',url])` with `stdio:'inherit'` printed
 * the truncated echo output followed by cmd.exe's own "not recognized"
 * error for the `state=...` fragment.
 *
 * Fix: hand the url to `explorer.exe` instead of going through cmd.exe at
 * all. explorer.exe is a normal Win32 executable, not a shell — it takes
 * the url as a single literal argument and forwards it straight to the
 * default browser via the URL protocol handler, with no `&`/`|`/`^`
 * reparsing anywhere in the chain. Verified the same repro's url (with a
 * live `&` in it) reaches explorer.exe as one untruncated argument.
 */
function openBrowser(url) {
  try {
    const [command, args] =
      process.platform === 'win32'
        ? ['explorer.exe', [url]]
        : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // no display / no handler registered — the printed URL above is the real fallback
    });
    child.unref();
  } catch {
    // same — printed URL is the fallback
  }
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

/** `quorum login` — browser-launch-and-poll flow, mirroring `gh auth login` / `vercel login`. */
export async function login() {
  let startRes;
  try {
    startRes = await fetch(`${WEB_ORIGIN}/api/cli/login/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
  } catch (err) {
    console.error(describeFetchError(err, WEB_ORIGIN));
    process.exitCode = 1;
    return;
  }

  if (!startRes.ok) {
    console.error(`Could not start login: ${await extractErrorMessage(startRes)}`);
    process.exitCode = 1;
    return;
  }

  const { requestId, state, loginUrl } = await startRes.json();

  console.log('Opening your browser to log in...');
  console.log('If it did not open automatically, visit this URL:');
  console.log(`  ${loginUrl}`);
  console.log('');
  openBrowser(loginUrl);
  console.log('Waiting for approval...');

  const pollUrl = new URL(`${WEB_ORIGIN}/api/cli/login/poll`);
  pollUrl.searchParams.set('requestId', requestId);
  pollUrl.searchParams.set('state', state);

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let exchangeCode = null;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let pollRes;
    try {
      pollRes = await fetch(pollUrl);
    } catch (err) {
      console.error(describeFetchError(err, WEB_ORIGIN));
      process.exitCode = 1;
      return;
    }

    if (!pollRes.ok) {
      console.error(`Login poll failed: ${await extractErrorMessage(pollRes)}`);
      process.exitCode = 1;
      return;
    }

    const body = await pollRes.json();
    if (body.status === 'pending') continue;

    if (body.status === 'expired') {
      console.error('Login request expired. Run `quorum login` again.');
      process.exitCode = 1;
      return;
    }

    if (body.status === 'approved') {
      exchangeCode = body.exchangeCode;
      break;
    }

    console.error(`Unexpected login status from server: ${body.status}`);
    process.exitCode = 1;
    return;
  }

  if (!exchangeCode) {
    console.error('Timed out waiting for login approval. Run `quorum login` again.');
    process.exitCode = 1;
    return;
  }

  // exchangeCode is short-lived and single-use — proceed immediately, no caching it.
  let exchangeRes;
  try {
    exchangeRes = await fetch(`${WEB_ORIGIN}/api/cli/login/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, exchangeCode })
    });
  } catch (err) {
    console.error(describeFetchError(err, WEB_ORIGIN));
    process.exitCode = 1;
    return;
  }

  if (!exchangeRes.ok) {
    console.error(`Login failed: ${await extractErrorMessage(exchangeRes)}`);
    process.exitCode = 1;
    return;
  }

  const { sessionToken, walletAddress, expiresAt } = await exchangeRes.json();
  await saveSession({ sessionToken, walletAddress, expiresAt });
  console.log(`Logged in as ${walletAddress}`);
}

/** `quorum logout` — revokes server-side if reachable, always clears the local session either way. */
export async function logout() {
  const session = await loadSession();

  if (session?.sessionToken) {
    try {
      await fetch(`${WEB_ORIGIN}/api/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.sessionToken}` }
      });
    } catch {
      // offline or server unreachable — logout must still succeed locally
    }
  }

  await clearSession();
  console.log('Logged out.');
}

/** `quorum whoami` — re-validates the local session against the server and prints the result. */
export async function whoami() {
  const session = await loadSession();
  if (!session) {
    console.log('Not logged in.');
    return;
  }

  let res;
  try {
    res = await fetch(`${WEB_ORIGIN}/api/auth/session`, {
      headers: { authorization: `Bearer ${session.sessionToken}` }
    });
  } catch (err) {
    console.error(describeFetchError(err, WEB_ORIGIN));
    process.exitCode = 1;
    return;
  }

  if (res.status === 401 || res.status === 403) {
    console.log('Session expired, run `quorum login`.');
    return;
  }

  if (!res.ok) {
    console.error(`Could not verify session: ${await extractErrorMessage(res)}`);
    process.exitCode = 1;
    return;
  }

  const body = await res.json().catch(() => ({}));
  const walletAddress = body.walletAddress || session.walletAddress;
  console.log(`Logged in as ${walletAddress}`);
}
