import test from 'node:test';
import assert from 'node:assert/strict';

import { buildEnvelopePrompt, parseEnvelope, ENVELOPE_QUALIFIERS } from '../executor/envelope.js';

test('parseEnvelope: a valid envelope parses correctly', () => {
  const raw = JSON.stringify({
    answer: 'About 5% of dispatch records failed verification.',
    claims: [
      {
        subject: 'dispatch records that failed verification',
        value: 5,
        unit: 'percent',
        denominator: null,
        basis: null,
        qualifier: 'measured',
        confidence: 0.9
      }
    ]
  });

  const result = parseEnvelope(raw);

  assert.equal(result.valid, true);
  assert.equal(result.reason, null);
  assert.equal(result.envelope.answer, 'About 5% of dispatch records failed verification.');
  assert.equal(result.envelope.claims.length, 1);
  assert.equal(result.envelope.claims[0].subject, 'dispatch records that failed verification');
  assert.equal(result.envelope.claims[0].value, 5);
  assert.equal(result.envelope.claims[0].unit, 'percent');
  assert.equal(result.envelope.claims[0].qualifier, 'measured');
});

test('parseEnvelope: claims with a null denominator/basis/qualifier/confidence still parse (all optional fields default to null)', () => {
  const raw = JSON.stringify({
    answer: 'ok',
    claims: [{ subject: 'x', value: 1, unit: 'records' }]
  });
  const result = parseEnvelope(raw);
  assert.equal(result.valid, true);
  assert.deepEqual(result.envelope.claims[0], {
    subject: 'x',
    value: 1,
    unit: 'records',
    denominator: null,
    basis: null,
    qualifier: null,
    confidence: null
  });
});

test('parseEnvelope: malformed JSON fails closed with a clear reason -- the batch is NOT silently treated as successful', () => {
  const result = parseEnvelope('This is not JSON at all -- just prose. About 5% of records failed.');
  assert.equal(result.valid, false);
  assert.equal(result.envelope, null);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
});

test('parseEnvelope: JSON wrapped in a markdown code fence fails closed -- no salvage, matching the fail-closed contract', () => {
  const wrapped = '```json\n' + JSON.stringify({ answer: 'ok', claims: [] }) + '\n```';
  const result = parseEnvelope(wrapped);
  assert.equal(result.valid, false);
  assert.ok(result.reason.length > 0);
});

test('parseEnvelope: empty/non-string output fails closed', () => {
  assert.equal(parseEnvelope('').valid, false);
  assert.equal(parseEnvelope('   ').valid, false);
  assert.equal(parseEnvelope(null).valid, false);
  assert.equal(parseEnvelope(undefined).valid, false);
});

test('parseEnvelope: "claims" missing or not an array fails closed', () => {
  assert.equal(parseEnvelope(JSON.stringify({ answer: 'ok' })).valid, false);
  assert.equal(parseEnvelope(JSON.stringify({ answer: 'ok', claims: 'not an array' })).valid, false);
  assert.equal(parseEnvelope(JSON.stringify({ answer: 'ok', claims: { subject: 'x' } })).valid, false);
});

test('parseEnvelope: a claim missing subject/value/unit fails closed -- the WHOLE batch fails, not just that one claim', () => {
  const missingUnit = JSON.stringify({ answer: 'ok', claims: [{ subject: 'x', value: 5 }] });
  const missingValue = JSON.stringify({ answer: 'ok', claims: [{ subject: 'x', unit: 'percent' }] });
  const missingSubject = JSON.stringify({ answer: 'ok', claims: [{ value: 5, unit: 'percent' }] });
  const wrongTypeValue = JSON.stringify({ answer: 'ok', claims: [{ subject: 'x', value: '5', unit: 'percent' }] });

  for (const raw of [missingUnit, missingValue, missingSubject, wrongTypeValue]) {
    const result = parseEnvelope(raw);
    assert.equal(result.valid, false, `expected invalid for: ${raw}`);
    assert.equal(result.envelope, null);
    assert.ok(result.reason && result.reason.length > 0, `expected a reason for: ${raw}`);
  }
});

test('parseEnvelope: a claim missing "answer" fails closed', () => {
  const result = parseEnvelope(JSON.stringify({ claims: [] }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /answer/);
});

test('parseEnvelope: an invalid qualifier or out-of-range confidence fails closed', () => {
  const badQualifier = JSON.stringify({ answer: 'ok', claims: [{ subject: 'x', value: 5, unit: 'percent', qualifier: 'guessed' }] });
  const badConfidence = JSON.stringify({ answer: 'ok', claims: [{ subject: 'x', value: 5, unit: 'percent', confidence: 1.5 }] });
  assert.equal(parseEnvelope(badQualifier).valid, false);
  assert.equal(parseEnvelope(badConfidence).valid, false);
  assert.ok(ENVELOPE_QUALIFIERS.includes('measured'));
});

test('buildEnvelopePrompt: wraps the batch content with the schema instruction, preserving the batch content verbatim', () => {
  const prompt = buildEnvelopePrompt('--- item:a ---\nSome batch content.', { kind: 'document-analysis' });
  assert.match(prompt, /Some batch content\./);
  assert.match(prompt, /"claims"/);
  assert.match(prompt, /"answer"/);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /document-analysis/);
});

test('buildEnvelopePrompt: falls back to a default task kind when none is given', () => {
  const prompt = buildEnvelopePrompt('content', {});
  assert.match(prompt, /document-analysis/);
});
