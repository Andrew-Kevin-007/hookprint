/**
 * bin/lib/init.js — `quorum init`, the first-run setup flow.
 *
 * Walks a new user to operational: creates `.env` from `.env.example` if
 * it's missing, prompts for any provider key that has none of its env vars
 * set (see bin/lib/providers.js), and offers to log in. Every plain prompt
 * uses node:readline/promises directly, per this task's brief; the one
 * prompt that must never echo back what was typed (an API key) uses
 * bin/lib/ui.js's promptSecret() instead — see that file's header for why
 * readline itself can't do that.
 *
 * Non-interactive (`process.stdin.isTTY` falsy — piped input, CI, a plain
 * `echo | quorum init`): never prompts, never hangs. It reports what's
 * missing and returns.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { PROVIDER_ENV_VARS } from './providers.js';
import { bold, dim, green, maskKey, promptSecret, red, yellow } from './ui.js';

/** One `rl.question()` per call — created and closed around each prompt so
 * it can never hold stdin in a mode that would conflict with promptSecret's
 * own raw-mode reads for the very next question. */
async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askYesNo(question, { defaultYes = false } = {}) {
  const suffix = defaultYes ? ' (Y/n) ' : ' (y/N) ';
  const answer = (await ask(question + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith('y');
}

/** Parse a real .env's text into a flat map, the same shape `process.loadEnvFile()` populates `process.env` from — good enough for "is this var set" checks without needing to reload the process's own environment mid-run. */
function parseEnvFile(text) {
  const map = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    map[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return map;
}

/** Set `KEY=value` inside a real .env's text, replacing an existing (possibly blank) assignment in place or appending a new one — preserves every other line, comment, and blank exactly as-is. */
function setEnvVar(envText, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(envText)) {
    return envText.replace(pattern, `${key}=${value}`);
  }
  return `${envText.replace(/\n*$/, '')}\n${key}=${value}\n`;
}

function reportMissingNonInteractive(envPath) {
  console.log('non-interactive session (no TTY) — reporting what is missing instead of prompting:');
  console.log('');

  const envExists = existsSync(envPath);
  console.log(envExists ? `${green('done')}    .env exists` : `${red('missing')} .env — copy .env.example to .env and fill in keys`);

  const envMap = envExists ? parseEnvFile(readFileSync(envPath, 'utf8')) : {};
  const missing = Object.entries(PROVIDER_ENV_VARS).filter(([, vars]) => !vars.some((v) => envMap[v]));
  const totalProviders = Object.keys(PROVIDER_ENV_VARS).length;

  if (missing.length === totalProviders) {
    console.log(`${red('missing')} no provider API keys set`);
  } else if (missing.length > 0) {
    console.log(`${yellow('partial')} providers without a key: ${missing.map(([p]) => p).join(', ')}`);
  } else {
    console.log(`${green('done')}    every provider slot has at least one key`);
  }

  console.log('');
  console.log('run `quorum init` again from an interactive terminal to set these up step by step.');
}

export async function runInit(root) {
  const envPath = join(root, '.env');
  const examplePath = join(root, '.env.example');

  console.log(bold('QUORUM setup'));
  console.log('');

  if (!process.stdin.isTTY) {
    reportMissingNonInteractive(envPath);
    return;
  }

  // Step 1: the .env file itself.
  if (!existsSync(envPath)) {
    if (existsSync(examplePath)) {
      copyFileSync(examplePath, envPath);
      console.log(`${green('✔')} created .env from .env.example`);
    } else {
      writeFileSync(envPath, '');
      console.log(`${green('✔')} created an empty .env (.env.example not found)`);
    }
  } else {
    console.log(`${green('✔')} .env already exists`);
  }

  let envText = readFileSync(envPath, 'utf8');
  const envMap = parseEnvFile(envText);

  // Step 2: provider keys — only ask about a provider with NONE of its env vars set.
  console.log('');
  console.log(bold('Provider keys'));
  const missingProviders = Object.entries(PROVIDER_ENV_VARS).filter(([, vars]) => !vars.some((v) => envMap[v]));

  if (missingProviders.length === 0) {
    console.log(`${green('✔')} at least one key already set for every provider`);
  } else {
    console.log(dim('press Enter to skip a provider you do not use'));
    for (const [provider, vars] of missingProviders) {
      const varName = vars[0];
      // eslint-disable-next-line no-await-in-loop -- one interactive prompt at a time, by design
      const value = await promptSecret(`  ${provider} (${varName}): `);
      if (value) {
        envText = setEnvVar(envText, varName, value);
        writeFileSync(envPath, envText);
        envMap[varName] = value;
        console.log(`  ${green('✔')} saved ${varName}=${maskKey(value)}`);
      }
    }
  }

  // Step 3: login.
  console.log('');
  console.log(bold('Login'));
  const { loadSession } = await import('./auth.js');
  const session = await loadSession();
  if (session) {
    console.log(`${green('✔')} already logged in`);
  } else if (await askYesNo('Log in now?')) {
    const { login } = await import('./auth.js');
    await login();
  } else {
    console.log(dim('  run `quorum login` any time'));
  }

  console.log('');
  console.log(`${green('done.')} run ${bold('quorum')} to see your status, or ${bold('quorum test')} to verify the build.`);
}
