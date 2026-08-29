/**
 * mint.test.js — origin/downstream wrapping around extract.js.
 *
 * node:test + node:assert/strict. Run with `node --test tests/*.test.js` from
 * packages/align (NOT `npm test`, NOT `node --test tests/` — both broken on
 * Node 24, see README.md).
 *
 * The real-data smoke test at the bottom points mintClaims/mintCandidates at
 * the actual demo corpus in D:\Tenori_Hack\ideation\ — the "0.79% — 2 of 252
 * dispatches" chain the whole pitch is built around. It is slower than a
 * synthetic fixture and deliberately not skipped: it is the only test in this
 * package that proves the parser survives real prose rather than hand-shaped
 * strings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { mintClaims, mintCandidates } from '../mint.js';

// The worktree this package lives in is nested under
// .claude/worktrees/<name>/packages/align — the real demo corpus is not
// inside the worktree at all, it is fixed at this absolute path in the repo
// checkout (see BUILD-PLAN.md). Resolved absolutely on purpose rather than
// walked up from __dirname.
const IDEATION_DIR = 'D:\\Tenori_Hack\\ideation';

function bytesAndText(str) {
  const fileBytes = Buffer.from(str, 'utf8');
  return { sourceText: fileBytes.toString('utf8'), fileBytes };
}

/* -------------------------------------------------------------------------- */
/* 5. mintClaims on a short fixture — construction succeeds, quote agrees     */
/* -------------------------------------------------------------------------- */

test('mintClaims on a fixture document produces Claims that construct without throwing, with exact evidence quotes', () => {
  const doc =
    "Kevin's fleet: 0.79% - 2 of 252 dispatches carried the confidence value. " +
    'The dashboard shipped on time. ' +
    '44% of the 289 reviewed items failed a check.';
  const { sourceText, fileBytes } = bytesAndText(doc);

  let claims;
  assert.doesNotThrow(() => {
    claims = mintClaims('fixtures/origin.md', sourceText, fileBytes);
  });

  // "The dashboard shipped on time" carries no quantity and must be dropped —
  // a Claim is a quantified assertion (contract.js).
  assert.equal(claims.length, 2);

  const expectedSha = createHash('sha256').update(fileBytes).digest('hex');
  for (const [i, c] of claims.entries()) {
    assert.equal(c.id, `c_${String(i + 1).padStart(3, '0')}`);
    assert.equal(c.hop, 1);
    assert.equal(c.evidence.source, 'fixtures/origin.md');
    assert.equal(c.evidence.sha256, expectedSha);
    assert.equal(
      c.evidence.quote,
      sourceText.slice(c.evidence.span.start, c.evidence.span.end),
      'evidence.quote must be exactly sourceText.slice(span.start, span.end)'
    );
    assert.equal(c.evidence.quote, c.text);
    assert.ok(c.quantity, 'a minted Claim must carry a quantity');
  }

  assert.equal(claims[0].denominator.value, 252);
  assert.equal(claims[1].denominator.value, 289);
});

test('mintClaims ids are sequential c_NNN in document order', () => {
  const doc = '44% of dispatches failed. 60% of reviewers agreed. 12% were unverified.';
  const { sourceText, fileBytes } = bytesAndText(doc);
  const claims = mintClaims('fixtures/seq.md', sourceText, fileBytes);
  assert.deepEqual(claims.map((c) => c.id), ['c_001', 'c_002', 'c_003']);
  assert.deepEqual(claims.map((c) => c.ordinal), [0, 1, 2]);
});

/* -------------------------------------------------------------------------- */
/* mintCandidates — every sentence harvested, quantity-less included          */
/* -------------------------------------------------------------------------- */

test('mintCandidates keeps every sentence, including quantity-less ones, and carries neighbours', () => {
  const doc = 'The summary opens here. 44% of dispatches failed. It closes with a note.';
  const { sourceText, fileBytes } = bytesAndText(doc);
  const candidates = mintCandidates('fixtures/hop2.md', sourceText, fileBytes, 2);

  assert.equal(candidates.length, 3);
  for (const [i, c] of candidates.entries()) {
    assert.equal(c.cid, `h2_${String(i + 1).padStart(3, '0')}`);
    assert.equal(c.hop, 2);
    assert.equal(c.file, 'fixtures/hop2.md');
  }
  assert.equal(candidates[0].quantity, null);
  assert.ok(candidates[1].quantity);
  assert.equal(candidates[2].quantity, null);

  assert.equal(candidates[0].neighbours.prevSpan, null);
  assert.deepEqual(candidates[0].neighbours.nextSpan, candidates[1].span);
  assert.deepEqual(candidates[1].neighbours.prevSpan, candidates[0].span);
  assert.deepEqual(candidates[1].neighbours.nextSpan, candidates[2].span);
  assert.equal(candidates[2].neighbours.nextSpan, null);
});

test('mintCandidates cid hop prefix must agree with the hop argument', () => {
  const doc = '44% of dispatches failed.';
  const { sourceText, fileBytes } = bytesAndText(doc);
  const candidates = mintCandidates('fixtures/hop3.md', sourceText, fileBytes, 3);
  assert.equal(candidates[0].cid, 'h3_001');
  assert.equal(candidates[0].hop, 3);
});

/* -------------------------------------------------------------------------- */
/* Parity, at the mint layer: mintClaims and mintCandidates agree on the      */
/* shared fields for the same source text (extract.js is the one parser).    */
/* -------------------------------------------------------------------------- */

test('mint-layer parity: mintClaims and mintCandidates agree on shared fields for the same sentence', () => {
  const doc = "Kevin's fleet: 0.79% - 2 of 252 dispatches carried the confidence value.";
  const { sourceText, fileBytes } = bytesAndText(doc);

  const [claim] = mintClaims('fixtures/origin.md', sourceText, fileBytes);
  const [candidate] = mintCandidates('fixtures/hop2.md', sourceText, fileBytes, 2).filter((c) => c.quantity !== null);

  assert.deepEqual(claim.text, candidate.text);
  // A Claim carries no top-level `span` (contract.js's makeClaim omits it —
  // only `evidence.span` exists); a Candidate does. Both must still agree.
  assert.deepEqual(claim.evidence.span, candidate.span);
  assert.deepEqual(claim.quantity, candidate.quantity);
  assert.deepEqual(claim.numerator, candidate.numerator);
  assert.deepEqual(claim.denominator, candidate.denominator);
  assert.deepEqual(claim.unit, candidate.unit);
  assert.deepEqual(claim.caveats, candidate.caveats);
});

/* -------------------------------------------------------------------------- */
/* 8. Real-data smoke test — the actual demo corpus                          */
/* -------------------------------------------------------------------------- */

test('real-data smoke test: mintClaims on the actual raven-deep-trust.md does not throw and finds a percent claim', () => {
  const filePath = path.join(IDEATION_DIR, 'raven-deep-trust.md');
  const fileBytes = readFileSync(filePath);
  const sourceText = fileBytes.toString('utf8');

  let claims;
  assert.doesNotThrow(() => {
    claims = mintClaims(filePath, sourceText, fileBytes);
  });
  assert.ok(claims.length > 0, 'expected at least one quantified claim in the real document');

  const percentClaims = claims.filter((c) => c.quantity.dimension === 'percent');
  assert.ok(percentClaims.length > 0, 'expected at least one percent-dimension claim');

  // The demo's own headline number: "Kevin's fleet: 0.79%" — 2 of 252 dispatches.
  const headline = claims.find((c) => c.quantity.raw === '0.79%');
  assert.ok(headline, 'expected to find the 0.79% claim from raven-deep-trust.md');
  assert.ok(headline.denominator, 'expected the 0.79% claim to carry a recovered denominator');
  assert.equal(headline.denominator.value, 252);
  assert.equal(headline.numerator.value, 2);

  for (const c of claims) {
    assert.equal(
      c.evidence.quote,
      sourceText.slice(c.evidence.span.start, c.evidence.span.end)
    );
  }
});

test('real-data smoke test: mintCandidates on the actual zeus-confidence-routing.md does not throw and re-finds the 0.79% restatement', () => {
  const filePath = path.join(IDEATION_DIR, 'zeus-confidence-routing.md');
  const fileBytes = readFileSync(filePath);
  const sourceText = fileBytes.toString('utf8');

  let candidates;
  assert.doesNotThrow(() => {
    candidates = mintCandidates(filePath, sourceText, fileBytes, 2);
  });
  assert.ok(candidates.length > 0, 'expected at least one candidate sentence in the real document');

  const percentCandidates = candidates.filter((c) => c.quantity && c.quantity.dimension === 'percent');
  assert.ok(percentCandidates.length > 0, 'expected at least one percent-dimension candidate');

  const restatement = candidates.find((c) => c.quantity && c.quantity.raw === '0.79%');
  assert.ok(restatement, 'expected to find a 0.79% restatement in zeus-confidence-routing.md');

  for (const c of candidates) {
    assert.equal(c.text, sourceText.slice(c.span.start, c.span.end));
  }
});
