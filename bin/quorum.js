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
 *   quorum test     run every package's test suite, PASS/FAIL per package + total
 *   quorum bench    run the real corruption benchmark (bench/run.js) and print it
 *   quorum --help   list commands
 *
 * No network calls. No API keys required for anything below — dispatch's
 * provider SDKs are imported by its own tests but never invoked live here.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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
