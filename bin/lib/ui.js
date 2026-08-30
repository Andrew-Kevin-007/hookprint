/**
 * bin/lib/ui.js — terminal presentation for the QUORUM CLI: colour, the
 * welcome-screen box, and a hand-rolled spinner. No dependency beyond
 * node:util/node:process — this project's CLI has exactly one runtime
 * dependency (@napi-rs/keyring, for session storage) and that stays true
 * here, matching packages/align and packages/sign's node:*-only convention.
 *
 * PLAIN_MODE is the one switch every animated/coloured helper here checks
 * first. It degrades to static, uncoloured, ANSI-free output whenever
 * stdout isn't a real TTY (piped to a file, redirected in CI) or NO_COLOR
 * is set — spinner frames and cursor-control codes in piped output are a
 * real bug, not a nice-to-have (see bin/quorum.js's header for the exact
 * `quorum test | cat` check this exists to pass).
 */

import { styleText } from 'node:util';

/** The site's brand accent, #38f997, as 24-bit RGB — util.styleText's named
 * palette has no truecolor support, so this one colour is a raw ANSI escape
 * rather than a styleText() call; every other colour below uses styleText. */
const ACCENT_RGB = [56, 249, 151];

export const PLAIN_MODE = !process.stdout.isTTY || Boolean(process.env.NO_COLOR);

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Length of a string as it will actually occupy on screen, ignoring any ANSI colour codes embedded in it — used to size the welcome box correctly even when its lines are already coloured. */
function visibleLength(text) {
  return text.replace(ANSI_PATTERN, '').length;
}

export function accent(text) {
  if (PLAIN_MODE) return text;
  return `\x1b[38;2;${ACCENT_RGB.join(';')}m${text}\x1b[0m`;
}

function styled(format, text) {
  if (PLAIN_MODE) return text;
  return styleText(format, text);
}

export const bold = (text) => styled('bold', text);
export const dim = (text) => styled('dim', text);
export const green = (text) => styled('green', text);
export const red = (text) => styled('red', text);
export const yellow = (text) => styled('yellow', text);

/** Draw a rounded box around pre-built lines (already-coloured strings are fine — width is measured on the visible text only, via visibleLength). */
export function box(lines, { minWidth = 0 } = {}) {
  const width = Math.max(minWidth, ...lines.map(visibleLength));
  const top = `╭${'─'.repeat(width + 2)}╮`;
  const bottom = `╰${'─'.repeat(width + 2)}╯`;
  const body = lines.map((line) => `│ ${line}${' '.repeat(width - visibleLength(line))} │`);
  return [top, ...body, bottom].join('\n');
}

/**
 * A minimal ANSI spinner for the genuinely slow commands (`quorum test`'s
 * five suites, `quorum run`'s per-batch provider calls). In PLAIN_MODE,
 * start()/stop() are no-ops — the caller prints its own final line exactly
 * as it always did, so piped/non-TTY output is byte-identical to before
 * this file existed. In a real TTY, start() renders an updating braille
 * frame + label on one line (clearing/rewriting it via \r + \x1b[2K, cursor
 * hidden for the duration) and stop()/succeed()/fail() clear that line.
 */
export class Spinner {
  static FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(label) {
    this.label = label;
    this.frameIndex = 0;
    this.timer = null;
  }

  start() {
    if (PLAIN_MODE) return this;
    process.stdout.write('\x1b[?25l');
    this._render();
    this.timer = setInterval(() => this._render(), 80);
    return this;
  }

  update(label) {
    this.label = label;
    return this;
  }

  _render() {
    const frame = Spinner.FRAMES[this.frameIndex];
    this.frameIndex = (this.frameIndex + 1) % Spinner.FRAMES.length;
    process.stdout.write(`\r\x1b[2K${accent(frame)} ${this.label}`);
  }

  /** Clear the spinner line with no replacement text — the caller prints its own settled-state line right after. */
  stop() {
    if (PLAIN_MODE) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stdout.write('\r\x1b[2K\x1b[?25h');
  }

  /** Clear the spinner line and print a final ✔ line in its place. */
  succeed(message = this.label) {
    this.stop();
    console.log(`${green('✔')} ${message}`);
  }

  /** Clear the spinner line and print a final ✘ line in its place. */
  fail(message = this.label) {
    this.stop();
    console.log(`${red('✘')} ${message}`);
  }
}

/** Mask a secret so a confirmation echo or status line never prints the full value — e.g. `gsk_...aB3d`. */
export function maskKey(value) {
  if (!value) return '';
  if (value.length <= 8) return '*'.repeat(value.length);
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Read one line of input with the terminal's echo disabled, so a pasted API
 * key never appears in plain text — used by `quorum init`. Hand-rolled
 * against raw stdin rather than `readline/promises`: readline always echoes
 * typed/pasted characters back at a real TTY (the terminal's own line
 * discipline does it, not readline itself), and there is no supported way
 * to suppress that through readline's public API. Every other prompt in
 * `quorum init` uses `readline/promises` directly, per this task's brief.
 *
 * Resolves '' immediately if stdin isn't a TTY, rather than hang — callers
 * only reach this after already checking process.stdin.isTTY, but this is
 * the same never-hang guarantee the rest of `init` relies on.
 */
export function promptSecret(question) {
  return new Promise((resolve) => {
    const { stdin } = process;
    process.stdout.write(question);

    if (!stdin.isTTY) {
      process.stdout.write('\n');
      resolve('');
      return;
    }

    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function cleanup() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    }

    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          // Ctrl-C — restore the terminal before exiting so the shell isn't left in raw mode.
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        input += ch;
        process.stdout.write('*');
      }
    }

    stdin.on('data', onData);
  });
}

/**
 * The bare-`quorum` welcome screen: the name with real visual weight, a
 * one-line statement of what it does, and REAL checked status — never
 * placeholders. `status` is gathered by the caller (bin/quorum.js's
 * cmdWelcome()) since this module does no I/O itself.
 */
export function renderWelcome({ availableProviders, missingProviders, supabaseConfigured, walletAddress }) {
  const totalProviders = availableProviders.length + missingProviders.length;
  const providerLine =
    availableProviders.length === 0
      ? `${red('none configured')} — ${missingProviders.length} provider(s) need a key`
      : missingProviders.length === 0
        ? `${green(`all ${totalProviders} configured`)}`
        : `${green(availableProviders.join(', '))} configured ${dim(`· ${missingProviders.length} missing (${missingProviders.join(', ')})`)}`;

  const dashboardLine = supabaseConfigured ? green('mirroring to Supabase') : dim('local ledger only (Supabase not configured)');
  const sessionLine = walletAddress ? `${green('logged in')} as ${walletAddress}` : dim('not logged in');

  const lines = [
    '',
    `${accent('●●●')} ${bold(accent('QUORUM'))}`,
    dim('trust-aware AI execution router'),
    '',
    `${bold('providers')}   ${providerLine}`,
    `${bold('dashboard')}   ${dashboardLine}`,
    `${bold('session')}     ${sessionLine}`,
    ''
  ];

  const needsSetup = missingProviders.length > 0 || !walletAddress;
  const hintLines = [
    '',
    dim('Next steps'),
    `  ${accent('quorum init')}      ${needsSetup ? 'finish setup (provider keys, login)' : 'review/redo setup'}`,
    `  ${accent('quorum test')}      verify the build (5 suites, ~30s)`,
    `  ${accent('quorum --help')}    see every command`
  ];

  return [box(lines, { minWidth: 48 }), ...hintLines].join('\n');
}
