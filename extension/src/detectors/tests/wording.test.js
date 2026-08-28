/**
 * CONTRACT.md rule 2, made mechanical.
 *
 * The banned phrases are assembled from fragments at runtime rather than
 * written out, so this file can scan itself along with everything else and
 * there is no exemption anywhere in the tree.
 *
 * The scan covers comments and identifiers, not just emitted strings: the
 * rule in CONTRACT.md is explicitly about code comments too, and a comment is
 * one screenshot away from being public.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDetectors } from '../index.js';
import {
  infiniteScrollIntersectionObserver,
  autoplayViaTimer,
  countdownWithReset,
  variableIntervalRefetch,
  variableIntervalUnresolvable
} from './fixtures.js';

const DETECTOR_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Fragments, joined with a tolerant separator, so the phrase never appears here. */
const BANNED = [
  ['slot', 'machine'],
  ['proof', 'of', 'manipulation'],
  ['proof', 'of', 'intent'],
  ['manipulating', 'you'],
  ['dark', 'pattern'],
  ['DSA', 'violation'],
  ['designed', 'to', 'addict'],
  ['addictive', 'by', 'design'],
  ['intentionally', 'addictive'],
  ['deliberately', 'manipulat'],
  ['proves', 'manipulation'],
  ['is', 'manipulating']
].map((parts) => ({
  label: parts.join(' '),
  pattern: new RegExp(parts.join('[\\s_-]*'), 'i')
}));

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...jsFilesUnder(full));
    } else if (entry.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

test('no banned phrase appears anywhere in the detector source', () => {
  const files = jsFilesUnder(DETECTOR_ROOT);
  assert.ok(files.length >= 9, `expected to scan the whole tree, found ${files.length} files`);

  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { label, pattern } of BANNED) {
      const match = text.match(pattern);
      if (match) violations.push(`${file}: "${match[0]}" (banned phrase: ${label})`);
    }
  }

  assert.deepEqual(violations, [], `CONTRACT.md rule 2 violation:\n${violations.join('\n')}`);
});

test('no banned phrase reaches any Manifest string', () => {
  const manifest = runDetectors([
    ...infiniteScrollIntersectionObserver(),
    ...autoplayViaTimer(),
    ...countdownWithReset(),
    ...variableIntervalRefetch(),
    ...variableIntervalUnresolvable()
  ]);

  assert.ok(manifest.findings.length >= 4, 'the fixture must actually produce output to scan');

  const serialised = JSON.stringify(manifest);
  for (const { label, pattern } of BANNED) {
    assert.equal(pattern.test(serialised), false, `Manifest contains banned phrase: ${label}`);
  }
});

test('the variable-interval finding uses the exact permitted wording', () => {
  const manifest = runDetectors(variableIntervalRefetch());
  const finding = manifest.findings.find((f) => f.mechanism === 'variable_interval_refetch');
  assert.ok(finding, 'fixture must produce the finding under test');

  assert.match(
    finding.observed.summary,
    /variable-interval event timing, a behavioural signal consistent with a variable-ratio reward schedule/,
    'CONTRACT.md prescribes this phrasing'
  );
});

test('no finding summary asserts intent', () => {
  const manifest = runDetectors([
    ...infiniteScrollIntersectionObserver(),
    ...autoplayViaTimer(),
    ...countdownWithReset(),
    ...variableIntervalRefetch()
  ]);

  // Verbs that would turn a measurement into an accusation.
  const intentVerbs = /\b(designed|intended|deliberate|deliberately|on purpose|in order to)\b/i;
  for (const f of manifest.findings) {
    assert.equal(
      intentVerbs.test(f.observed.summary),
      false,
      `"${f.observed.summary}" reads as a claim about intent`
    );
  }
});
