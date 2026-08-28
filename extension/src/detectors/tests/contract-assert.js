/**
 * Mechanical validation of a Finding against CONTRACT.md.
 *
 * Every test that produces a Finding runs it through here, so a shape
 * regression fails a test rather than reaching the UI.
 */

import assert from 'node:assert/strict';
import { MECHANISMS, CONFIDENCE, SUPPORTED_ACTIONS } from '../util.js';

export function assertValidFinding(finding, label = 'finding') {
  assert.ok(finding && typeof finding === 'object', `${label}: not an object`);

  assert.match(finding.id, /^f_\d{3,}$/, `${label}: id must be f_NNN, got ${finding.id}`);
  assert.ok(MECHANISMS.includes(finding.mechanism), `${label}: illegal mechanism "${finding.mechanism}"`);
  assert.equal(typeof finding.display_name, 'string', `${label}: display_name must be a string`);
  assert.ok(finding.display_name.length > 0, `${label}: display_name must be non-empty`);
  assert.ok(CONFIDENCE.includes(finding.confidence), `${label}: illegal confidence "${finding.confidence}"`);

  const e = finding.evidence;
  assert.ok(e && typeof e === 'object', `${label}: evidence missing`);
  assert.equal(typeof e.file, 'string', `${label}: evidence.file must be a string`);
  assert.ok(e.file.length > 0, `${label}: evidence.file must be non-empty`);
  assert.ok(Number.isInteger(e.line) && e.line > 0, `${label}: evidence.line must be a positive integer`);
  assert.ok(Number.isInteger(e.column) && e.column > 0, `${label}: evidence.column must be a positive integer`);
  assert.equal(typeof e.snippet, 'string', `${label}: evidence.snippet must be a string`);

  const o = finding.observed;
  assert.ok(o && typeof o === 'object', `${label}: observed missing`);
  assert.equal(typeof o.summary, 'string', `${label}: observed.summary must be a string`);
  assert.ok(o.summary.length > 0, `${label}: observed.summary must be non-empty`);
  assert.ok(o.metrics && typeof o.metrics === 'object', `${label}: observed.metrics must be an object`);

  const a = finding.action;
  assert.ok(a && typeof a === 'object', `${label}: action missing`);
  assert.equal(typeof a.supported, 'boolean', `${label}: action.supported must be a boolean`);

  // The honest support matrix: true only where a kill switch exists.
  const expectSupported = Object.prototype.hasOwnProperty.call(SUPPORTED_ACTIONS, finding.mechanism);
  assert.equal(
    a.supported,
    expectSupported,
    `${label}: action.supported for "${finding.mechanism}" must be ${expectSupported}`
  );

  if (a.supported) {
    assert.equal(typeof a.label, 'string', `${label}: supported action needs a label`);
    assert.equal(typeof a.action_id, 'string', `${label}: supported action needs an action_id`);
  } else {
    // CONTRACT.md: "Absent when `supported` is `false`."
    assert.ok(!('label' in a), `${label}: unsupported action must not carry a label`);
    assert.ok(!('action_id' in a), `${label}: unsupported action must not carry an action_id`);
  }
}

export function assertValidManifest(manifest) {
  assert.equal(typeof manifest.url, 'string', 'manifest.url must be a string');
  assert.equal(typeof manifest.scanned_at, 'string', 'manifest.scanned_at must be a string');
  assert.ok(Array.isArray(manifest.findings), 'manifest.findings must be an array');
  assert.ok(Array.isArray(manifest.dropped), 'manifest.dropped must be an array');

  const ids = new Set();
  for (const f of manifest.findings) {
    assertValidFinding(f, `manifest finding ${f.id}`);
    assert.ok(!ids.has(f.id), `duplicate finding id ${f.id}`);
    ids.add(f.id);
  }
  for (const d of manifest.dropped) {
    assert.ok(MECHANISMS.includes(d.proposed_mechanism), `illegal dropped mechanism "${d.proposed_mechanism}"`);
    assert.equal(typeof d.reason, 'string', 'dropped.reason must be a string');
    assert.ok(d.reason.length > 0, 'dropped.reason must be non-empty');
  }
}
