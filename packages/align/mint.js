/**
 * mint.js — promote the origin document's Parsed cores into Claims: allocate
 * `c_NNN` ids, attach evidence pointers, and drop anything that is not a
 * quantified assertion. Its mirror, `mintCandidates`, promotes a downstream
 * document's Parsed cores into Candidates instead — hop-tagged, no id,
 * `neighbours` attached. Both call extract.js and never re-parse; that is
 * the one hard invariant (README.md).
 *
 * Owns: Parsed[] -> Claim[] / Candidate[]. Depends on: extract, contract.
 * Ids are minted here and NEVER written downstream — that is the product.
 *
 * ---------------------------------------------------------------------------
 * BYTES VS STRING — the Windows trap.
 *
 * `sha256` is computed over the source file's raw BYTES (a Buffer), never
 * over the decoded string — `createHash('sha256').update(fileBytes)`. Spans
 * and quotes index the DECODED STRING (`readFileSync(path, 'utf8')`), per
 * contract.js decision 2. Hashing the decoded string instead of the buffer
 * would silently produce a different digest for any file containing a
 * character outside the BMP or, on this OS, a byte sequence Node's UTF-8
 * decoder normalises on the way in — so callers must pass both forms in, not
 * just the string, and this file never re-derives one from the other.
 */

import { createHash } from 'node:crypto';
import { extractParsed, extractRecords } from './extract.js';
import { makeClaim, makeCandidate } from './contract.js';

function sha256OfBytes(fileBytes) {
  return createHash('sha256').update(fileBytes).digest('hex');
}

/**
 * An origin document -> Claim[]. Only sentences carrying a primary quantity
 * survive (`requireQuantity: true`) — a Claim is a quantified assertion by
 * definition (contract.js). Origin claims are always hop 1 in this design.
 *
 * @param {string} sourcePath  File path the claim is attributed to.
 * @param {string} sourceText  The DECODED string (readFileSync(path,'utf8')) — spans/quotes index this.
 * @param {Buffer} fileBytes   The raw file bytes — sha256 is computed over this.
 */
export function mintClaims(sourcePath, sourceText, fileBytes) {
  const parsedSentences = extractParsed(sourceText, { requireQuantity: true });
  const sha256 = sha256OfBytes(fileBytes);

  return parsedSentences.map((p, i) => makeClaim({
    id: `c_${String(i + 1).padStart(3, '0')}`,
    hop: 1,
    evidence: {
      source: sourcePath,
      sha256,
      span: p.span,
      quote: sourceText.slice(p.span.start, p.span.end)
    },
    ...p
  }));
}

/**
 * A downstream document -> Candidate[]. Every sentence is harvested
 * (`requireQuantity: false`) — a candidate with no quantity is exactly what
 * earns the `no_quantity` unaligned receipt downstream (fallback C's honesty
 * floor), not something to drop here.
 *
 * @param {string} sourcePath  File path the candidate was read from.
 * @param {string} sourceText  The DECODED string — spans index this.
 * @param {Buffer} fileBytes   The raw file bytes — sha256 is computed over this.
 * @param {number} hop         Which hop this document is (>= 1); becomes the `hN_` prefix of every cid.
 */
export function mintCandidates(sourcePath, sourceText, fileBytes, hop) {
  const records = extractRecords(sourceText, { requireQuantity: false });
  const sha256 = sha256OfBytes(fileBytes);

  return records.map(({ parsed, prevSpan, nextSpan }, i) => makeCandidate({
    cid: `h${hop}_${String(i + 1).padStart(3, '0')}`,
    hop,
    file: sourcePath,
    sha256,
    neighbours: { prevSpan, nextSpan },
    ...parsed
  }));
}
