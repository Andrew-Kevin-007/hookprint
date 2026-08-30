/**
 * ui.test.js — regression coverage for bin/lib/ui.js's hand-rolled bits:
 * key masking, box alignment, and (the highest-risk new code in this
 * feature) promptSecret()'s raw-stdin character handling, which exists
 * specifically so a pasted API key is never echoed to the terminal.
 *
 * Forces NO_COLOR=1 before importing ui.js (mirrors auth.test.js's
 * QUORUM_SESSION_BACKEND=file pattern) so PLAIN_MODE is deterministically
 * true here regardless of whether this test runs under a real TTY —
 * accent()/bold()/etc. must be pure passthroughs in that mode, no ANSI.
 */

process.env.NO_COLOR = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  accent, bold, box, dim, green, maskKey, progressBar, promptSecret, red,
  renderChain, Spinner, stageHeader, statusLine, treeLines, yellow, PLAIN_MODE
} from '../lib/ui.js';

/** Capture whatever a callback writes to stdout, restoring the real write afterward regardless of how the callback exits. */
function captureStdout(fn) {
  const original = process.stdout.write;
  const chunks = [];
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('NO_COLOR forces PLAIN_MODE, and every styling helper becomes a passthrough', () => {
  assert.equal(PLAIN_MODE, true);
  for (const fn of [accent, bold, dim, green, red, yellow]) {
    assert.equal(fn('hello'), 'hello');
  }
});

test('maskKey never returns the full value, and masks short values entirely', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short1'), '******'); // len 6, <=8 -> fully masked
  const long = 'gsk_abcd1234567890XYZ';
  const masked = maskKey(long);
  assert.ok(!masked.includes(long), 'masked output must not contain the full key');
  assert.equal(masked, `${long.slice(0, 4)}...${long.slice(-4)}`);
});

test('box() pads every line to the same visible width, including the borders', () => {
  const rendered = box(['a', 'a longer line', ''], { minWidth: 0 });
  const lines = rendered.split('\n');
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1, `expected every box line to be the same length, got widths: ${[...widths]}`);
  assert.ok(lines[0].startsWith('╭') && lines[0].endsWith('╮'));
  assert.ok(lines.at(-1).startsWith('╰') && lines.at(-1).endsWith('╯'));
});

test('box() respects minWidth even when every content line is shorter', () => {
  const rendered = box(['x'], { minWidth: 20 });
  const [top] = rendered.split('\n');
  assert.equal(top.length, 24); // minWidth + 2 (box()'s own border padding) + 2 corner chars
});

test('Spinner in PLAIN_MODE: start() writes nothing, succeed()/fail() print exactly one plain line', () => {
  const spinner = new Spinner('working...');

  const duringStart = captureStdout(() => spinner.start());
  assert.equal(duringStart, '', 'start() must not write anything in PLAIN_MODE');

  const onSuccess = new Spinner('working...');
  const succeedOutput = captureStdout(() => {
    onSuccess.start();
    onSuccess.succeed('all good');
  });
  assert.equal(succeedOutput, '✔ all good\n');

  const onFailure = new Spinner('working...');
  const failOutput = captureStdout(() => {
    onFailure.start();
    onFailure.fail('went wrong');
  });
  assert.equal(failOutput, '✘ went wrong\n');
});

/**
 * promptSecret() is hand-rolled against raw process.stdin rather than
 * readline (see its own doc comment for why). This drives the REAL
 * function against the real process.stdin object, temporarily stubbing
 * only the bits that would otherwise touch the real terminal
 * (isTTY/setRawMode/resume/pause/setEncoding) and manually emitting 'data'
 * events to simulate keystrokes -- the same EventEmitter mechanism a real
 * keypress would trigger, without needing an actual pty in CI.
 */
test('promptSecret masks every typed character, honours backspace, and never echoes the real value', async () => {
  const stdin = process.stdin;
  const listenersBefore = stdin.listenerCount('data');

  const originalIsTTY = stdin.isTTY;
  const originalSetRawMode = stdin.setRawMode;
  const originalResume = stdin.resume;
  const originalPause = stdin.pause;
  const originalSetEncoding = stdin.setEncoding;
  const originalWrite = process.stdout.write;

  Object.defineProperty(stdin, 'isTTY', { value: true, configurable: true });
  stdin.setRawMode = () => {};
  stdin.resume = () => {};
  stdin.pause = () => {};
  stdin.setEncoding = () => {};

  const written = [];
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };

  let result;
  try {
    const promise = promptSecret('key: ');
    // "gsk_abc" typed, then a backspace (drops the trailing "c"), then Enter.
    stdin.emit('data', 'gsk_abc');
    stdin.emit('data', '\u007f');
    stdin.emit('data', '\r');
    result = await promise;
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    stdin.setRawMode = originalSetRawMode;
    stdin.resume = originalResume;
    stdin.pause = originalPause;
    stdin.setEncoding = originalSetEncoding;
  }

  assert.equal(result, 'gsk_ab', 'backspace should have dropped the trailing character before Enter');
  assert.equal(stdin.listenerCount('data'), listenersBefore, 'promptSecret must remove its data listener once settled, not leak it');

  const echoed = written.join('');
  assert.ok(!echoed.includes('gsk_ab'), 'the real typed value must never be written to stdout');
  assert.ok(echoed.includes('*'), 'each typed character should echo as a mask character');
});

test('stageHeader in PLAIN_MODE is a bare "[index/total] TITLE" line, no box-drawing or colour', () => {
  assert.equal(stageHeader(1, 7, 'INTAKE'), '\n[1/7] INTAKE');
  assert.equal(stageHeader(7, 7, 'VERIFY'), '\n[7/7] VERIFY');
});

test('progressBar in PLAIN_MODE is the bare fraction, no block-drawing bar', () => {
  assert.equal(progressBar(2, 4), '2/4');
  assert.equal(progressBar(0, 1), '0/1');
});

test('renderChain in PLAIN_MODE arrow-joins providers and suffixes failed ones, "none" when empty', () => {
  assert.equal(renderChain(['groq', 'openrouter']), 'groq -> openrouter');
  assert.equal(renderChain(['groq', 'openrouter'], { failed: ['groq'] }), 'groq(failed) -> openrouter');
  assert.equal(renderChain([]), 'none');
});

test('statusLine pairs the right icon with ok/fail/warn/info, defaulting unknown kinds to info', () => {
  assert.equal(statusLine('ok', 'done'), '✔ done');
  assert.equal(statusLine('fail', 'broken'), '✘ broken');
  assert.equal(statusLine('warn', 'careful'), '! careful');
  assert.equal(statusLine('info', 'fyi'), 'i fyi');
  assert.equal(statusLine('nonsense', 'x'), 'i x');
});

test('treeLines branches every item except the last with "├─", the last with "└─"', () => {
  assert.deepEqual(treeLines(['a', 'b', 'c']), ['  ├─ a', '  ├─ b', '  └─ c']);
  assert.deepEqual(treeLines(['solo']), ['  └─ solo']);
  assert.deepEqual(treeLines([]), []);
});

test('promptSecret resolves empty immediately when stdin is not a TTY, rather than hang', async () => {
  const stdin = process.stdin;
  const originalIsTTY = stdin.isTTY;
  Object.defineProperty(stdin, 'isTTY', { value: false, configurable: true });

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;

  let result;
  try {
    result = await promptSecret('key: ');
  } finally {
    process.stdout.write = originalWrite;
    Object.defineProperty(stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  }

  assert.equal(result, '');
});
