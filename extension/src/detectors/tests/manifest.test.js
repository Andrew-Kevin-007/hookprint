import test from 'node:test';
import assert from 'node:assert/strict';

import { runDetectors, DETECTORS } from '../index.js';
import { assertValidManifest, assertValidFinding } from './contract-assert.js';
import {
  infiniteScrollIntersectionObserver,
  autoplayViaTimer,
  countdownWithReset,
  variableIntervalRefetch,
  cleanControlPage,
  emptyStream
} from './fixtures.js';

test('a page running all four mechanics yields one contract-valid Manifest', () => {
  const events = [
    ...infiniteScrollIntersectionObserver(),
    ...autoplayViaTimer(),
    ...countdownWithReset(),
    ...variableIntervalRefetch()
  ];

  const manifest = runDetectors(events, {
    url: 'https://example.com/feed',
    scannedAt: '2026-08-28T14:30:00Z'
  });

  assertValidManifest(manifest);
  assert.equal(manifest.url, 'https://example.com/feed');
  assert.equal(manifest.scanned_at, '2026-08-28T14:30:00Z');

  const mechanisms = manifest.findings.map((f) => f.mechanism).sort();
  assert.deepEqual(mechanisms, [
    'autoplay',
    'countdown_timer',
    'infinite_scroll',
    'variable_interval_refetch'
  ]);

  // Ids are allocated once per scan, across every detector.
  assert.deepEqual(
    manifest.findings.map((f) => f.id),
    ['f_001', 'f_002', 'f_003', 'f_004']
  );
});

test('the clean control page yields an empty Manifest, findings and dropped both', () => {
  const manifest = runDetectors(cleanControlPage(), { url: 'http://localhost:5501/pages/05-clean.html' });

  assertValidManifest(manifest);
  assert.deepEqual(
    manifest.findings,
    [],
    `FALSE POSITIVE on the control page: ${JSON.stringify(manifest.findings, null, 2)}`
  );
  assert.deepEqual(manifest.dropped, []);
});

test('an empty event stream yields an empty Manifest', () => {
  const manifest = runDetectors(emptyStream(), { url: 'about:blank' });
  assertValidManifest(manifest);
  assert.equal(manifest.findings.length, 0);
});

test('malformed input does not throw and does not invent findings', () => {
  for (const input of [null, undefined, 'not an array', 42, [null, undefined, {}, { type: 'x' }]]) {
    const manifest = runDetectors(input, { url: 'https://x.test/' });
    assertValidManifest(manifest);
    assert.equal(manifest.findings.length, 0);
  }
});

test('only supported mechanics carry a kill switch', () => {
  const events = [
    ...infiniteScrollIntersectionObserver(),
    ...autoplayViaTimer(),
    ...countdownWithReset(),
    ...variableIntervalRefetch()
  ];
  const { findings } = runDetectors(events);

  const supported = findings.filter((f) => f.action.supported).map((f) => f.mechanism).sort();
  assert.deepEqual(supported, ['autoplay', 'infinite_scroll']);

  for (const f of findings.filter((x) => !x.action.supported)) {
    assert.ok(!('label' in f.action), `${f.mechanism} must not carry a label`);
    assert.ok(!('action_id' in f.action), `${f.mechanism} must not carry an action_id`);
  }
});

test('one detector throwing does not take down the scan', () => {
  const exploding = {
    MECHANISM: 'unknown',
    analyse() {
      throw new Error('synthetic detector failure');
    }
  };

  const manifest = runDetectors(autoplayViaTimer(), {
    detectors: [exploding, ...DETECTORS]
  });

  assertValidManifest(manifest);
  assert.equal(manifest.findings.length, 1, 'the other detectors still ran');
  assert.equal(manifest.findings[0].mechanism, 'autoplay');

  const failure = manifest.dropped.find((d) => d.reason === 'detector error');
  assert.ok(failure, 'the failure is recorded, not swallowed');
  assert.equal(failure.detail, 'synthetic detector failure');
});

test('events arriving out of order are handled', () => {
  const shuffled = [...infiniteScrollIntersectionObserver()].reverse();
  const manifest = runDetectors(shuffled);
  assertValidManifest(manifest);
  assert.equal(manifest.findings.length, 1);
  assert.equal(manifest.findings[0].mechanism, 'infinite_scroll');
});

test('scanned_at defaults to a valid ISO timestamp', () => {
  const manifest = runDetectors(emptyStream());
  assert.ok(!Number.isNaN(Date.parse(manifest.scanned_at)));
});

test('every detector exposes the agreed detect(events) signature', () => {
  for (const detector of DETECTORS) {
    assert.equal(typeof detector.detect, 'function', `${detector.MECHANISM} missing detect`);
    assert.equal(typeof detector.analyse, 'function', `${detector.MECHANISM} missing analyse`);

    const findings = detector.detect([]);
    assert.ok(Array.isArray(findings), `${detector.MECHANISM}.detect must return an array`);
    assert.equal(findings.length, 0);
  }
});

test('detect() returns the same findings as analyse().findings', () => {
  const events = [...infiniteScrollIntersectionObserver(), ...autoplayViaTimer()];
  for (const detector of DETECTORS) {
    const viaDetect = detector.detect(events);
    const viaAnalyse = detector.analyse(events).findings;
    assert.equal(viaDetect.length, viaAnalyse.length);
    viaDetect.forEach((f) => assertValidFinding(f));
  }
});
