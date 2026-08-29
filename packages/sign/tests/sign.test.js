import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { generateIdentity, keyIdOf } from '../keys.js';
import { signBundle } from '../sign.js';
import { verifyBundle } from '../verify.js';
import { canonicalize } from '../canonicalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REALISTIC_CLAIM = {
  id: 'c_003',
  text: '44% of the 289 dispatches failed an unverified quota check',
  quantity: { raw: '44%', value: 0.44, dimension: 'percent', band: [0.435, 0.445] },
  numerator: { value: 127, unit: 'dispatches' },
  denominator: { value: 289, unit: 'dispatches' },
  evidence: { source: 'fixtures/quota-log.md', span: { start: 1840, end: 1993 } },
};

test('sign then verify a realistic claim bundle succeeds', () => {
  const { publicKey, privateKey } = generateIdentity();
  const att = signBundle(REALISTIC_CLAIM, privateKey, publicKey);
  assert.equal(verifyBundle(REALISTIC_CLAIM, att.signature, att.publicKey), true);
});

test('tampering one nested field after signing breaks verification', () => {
  const { publicKey, privateKey } = generateIdentity();
  const att = signBundle(REALISTIC_CLAIM, privateKey, publicKey);
  const tampered = { ...REALISTIC_CLAIM, quantity: { ...REALISTIC_CLAIM.quantity, value: 0.60 } };
  assert.equal(verifyBundle(tampered, att.signature, att.publicKey), false);
});

test('tampering the denominator (the differentiator field) breaks verification', () => {
  const { publicKey, privateKey } = generateIdentity();
  const att = signBundle(REALISTIC_CLAIM, privateKey, publicKey);
  const tampered = { ...REALISTIC_CLAIM, denominator: { ...REALISTIC_CLAIM.denominator, value: 37 } };
  assert.equal(verifyBundle(tampered, att.signature, att.publicKey), false);
});

test('a corrupted signature fails closed, never throws', () => {
  const { publicKey, privateKey } = generateIdentity();
  const att = signBundle(REALISTIC_CLAIM, privateKey, publicKey);
  const brokenSig = att.signature.slice(0, -4) + 'AAAA';
  assert.doesNotThrow(() => verifyBundle(REALISTIC_CLAIM, brokenSig, att.publicKey));
  assert.equal(verifyBundle(REALISTIC_CLAIM, brokenSig, att.publicKey), false);
});

test('a garbage signature and a garbage public key both fail closed, never throw', () => {
  assert.equal(verifyBundle(REALISTIC_CLAIM, 'not-base64-!!!', 'also-not-base64-!!!'), false);
  assert.equal(verifyBundle(REALISTIC_CLAIM, '', ''), false);
});

test('the wrong public key fails verification even with a genuinely valid signature', () => {
  const signer = generateIdentity();
  const impostor = generateIdentity();
  const att = signBundle(REALISTIC_CLAIM, signer.privateKey, signer.publicKey);
  assert.equal(verifyBundle(REALISTIC_CLAIM, att.signature, impostor.publicKey), false);
});

test('canonicalize is key-order independent: same content, different construction order, identical bytes', () => {
  const a = { z: 1, a: { y: 2, b: 3 }, m: [3, 1, 2] };
  const b = { a: { b: 3, y: 2 }, z: 1, m: [3, 1, 2] };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('canonicalize preserves array order — arrays are semantic, not sorted', () => {
  const a = { list: [1, 2, 3] };
  const b = { list: [3, 2, 1] };
  assert.notEqual(canonicalize(a), canonicalize(b));
});

test('signatures over key-reordered but content-identical bundles are byte-identical', () => {
  const { publicKey, privateKey } = generateIdentity();
  const a = { id: 'x', quantity: { value: 1, unit: 'u' } };
  const b = { quantity: { unit: 'u', value: 1 }, id: 'x' };
  const sigA = signBundle(a, privateKey, publicKey).signature;
  const sigB = signBundle(b, privateKey, publicKey).signature;
  assert.equal(sigA, sigB);
});

test('keyId is deterministic for the same public key and differs across identities', () => {
  const id1 = generateIdentity();
  const id2 = generateIdentity();
  assert.equal(keyIdOf(id1.publicKey), keyIdOf(id1.publicKey));
  assert.notEqual(keyIdOf(id1.publicKey), keyIdOf(id2.publicKey));
  assert.match(id1.keyId, /^[0-9a-f]{16}$/);
});

test('module graph contains zero network imports — this package runs with the network off', () => {
  const files = readdirSync(join(__dirname, '..')).filter((f) => f.endsWith('.js'));
  const bannedPattern = /\b(fetch|http|https|net|dns|child_process)\b/;
  for (const file of files) {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const importLines = src.split('\n').filter((l) => l.trim().startsWith('import'));
    for (const line of importLines) {
      assert.match(line, /from ['"]node:|from ['"]\.\//, `${file}: unexpected import — ${line.trim()}`);
      assert.doesNotMatch(line, bannedPattern, `${file}: banned module reference — ${line.trim()}`);
    }
  }
});
