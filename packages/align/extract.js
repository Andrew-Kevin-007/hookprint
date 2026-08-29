/**
 * extract.js — THE ONE PARSER. Turns a document into Parsed cores.
 *
 * Origins and candidates both come from here. If they are ever parsed by
 * different code the diff compares two parsers' opinions and emits phantom
 * deltas. See README.md, "The one hard invariant".
 *
 * Owns: document -> Parsed[]. Depends on: lexicon, text, quantity, contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES, IN ORDER, PER SENTENCE.
 *
 * 1. Split the document into paragraphs, then sentences within each
 *    paragraph, carrying absolute (document) offsets throughout.
 * 2. Parse every quantity mention in the sentence and pick the primary one
 *    (pickPrimary). A sentence with none gets `quantity: null`.
 * 3. Resolve a numerator/denominator for that primary quantity — see
 *    `resolveMagnitudes` below for the four cases, cheapest first.
 * 4. Find the unit named right after the primary quantity (headNounAfter).
 * 5. Scan the sentence for CAVEAT_MARKERS terms and build its own caveats
 *    array. Neighbouring sentences' caveats are NOT folded in here — a
 *    hoisted caveat belongs to the sentence that carries it; `neighbours`
 *    (see `extractRecords`) is what lets a later ±1 window check (diff.js's
 *    concern, not this file's) tell a hoist apart from a strip, per
 *    README.md's own note on Candidate.neighbours. Duplicating that check
 *    here would be the second parser this file exists to prevent.
 * 6. Build a contract.js Parsed via `makeParsed`, with `ordinal` assigned as
 *    the 0-based position among the sentences that survive filtering, in
 *    document order.
 */

import { splitParagraphs, splitSentences } from './text.js';
import { parseQuantities, pickPrimary, headNounAfter } from './quantity.js';
import { CAVEAT_MARKERS } from './lexicon.js';
import { makeParsed } from './contract.js';

/* -------------------------------------------------------------------------- */
/* Numerator / denominator resolution                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve {numerator, denominator} for one sentence's primary quantity.
 *
 * Four cases, cheapest and most-certain first. Each one either returns
 * immediately or falls through to the next — a sentence gets the first
 * applicable answer, never a blend of two.
 *
 *   A.  The primary IS a ratio mention ("2 of 17") — quantity.js's own
 *       ratios() already attached both sides. Nothing to resolve.
 *   A2. A SEPARATE ratio mention sits in the same sentence as a percent
 *       primary ("0.79% — 2 of 252 dispatches" is one fact stated two ways,
 *       not two facts) — borrow its numerator/denominator.
 *   B.  A plain count/dimensionless mention elsewhere in the SAME SENTENCE
 *       names what it counts ("44% of the 289 dispatches") — that count is
 *       the base.
 *   C.  Nothing in this sentence at all — look backward through the SAME
 *       PARAGRAPH's already-parsed sentences (nearest first) for one whose
 *       own primary quantity is a count/dimensionless with a unit compatible
 *       with this sentence's own unit ("We examined 289 dispatches. 44%
 *       failed."). Same paragraph only — BUILD-PLAN.md's stated scope, not
 *       the whole document.
 *
 * Neither A nor A2 attach a unit to the numerator — quantity.js's ratios()
 * never does, because the corpus genuinely elides it ("2 of 252 dispatches"
 * — the "2" has no unit of its own, only "252" does). The denominator's unit
 * IS recovered here via headNounAfter when quantity.js left it null.
 */
function resolveMagnitudes(primary, allQuantities, sentenceText, offset, paraLocal, unit) {
  // Case A: the primary mention is itself a ratio.
  if (primary.numerator || primary.denominator) {
    return {
      numerator: primary.numerator,
      denominator: withDenominatorUnit(primary.denominator, sentenceText, offset)
    };
  }

  const needsBase = primary.dimension === 'percent' || primary.dimension === 'ratio';
  if (!needsBase) return { numerator: null, denominator: null };

  // Case A2: a separate ratio mention in the same sentence.
  for (const q of allQuantities) {
    if (q === primary || q.suppressed) continue;
    if (q.dimension === 'ratio' && q.numerator && q.denominator) {
      return { numerator: q.numerator, denominator: withDenominatorUnit(q.denominator, sentenceText, offset) };
    }
  }

  // Case B: a plain count/dimensionless mention naming its own base, in the
  // same sentence.
  for (const q of allQuantities) {
    if (q === primary || q.suppressed) continue;
    if (q.dimension !== 'count' && q.dimension !== 'dimensionless') continue;
    const headUnit = headNounAfter(sentenceText, q.span, offset);
    return {
      numerator: null,
      denominator: {
        value: q.value,
        unit: headUnit ? headUnit.term : null,
        unitStem: headUnit ? headUnit.stem : null,
        provenance: 'derived',
        span: q.span
      }
    };
  }

  // Case C: paragraph-scope inheritance from an earlier sentence.
  for (let i = paraLocal.length - 1; i >= 0; i -= 1) {
    const prev = paraLocal[i];
    if (!prev.quantity) continue;
    if (prev.quantity.dimension !== 'count' && prev.quantity.dimension !== 'dimensionless') continue;
    if (!unitsCompatible(unit, prev.unit)) continue;
    return {
      numerator: null,
      denominator: {
        value: prev.quantity.value,
        unit: prev.unit ? prev.unit.term : null,
        unitStem: prev.unit ? prev.unit.stem : null,
        provenance: 'inherited',
        span: prev.quantity.span
      }
    };
  }

  return { numerator: null, denominator: null };
}

/** Recover a denominator's unit via headNounAfter when quantity.js left it null. */
function withDenominatorUnit(denominator, sentenceText, offset) {
  if (!denominator || denominator.unit) return denominator;
  const headUnit = headNounAfter(sentenceText, denominator.span, offset);
  if (!headUnit) return denominator;
  return { ...denominator, unit: headUnit.term, unitStem: headUnit.stem };
}

/** Either side missing is "no evidence to contradict", not a mismatch. */
function unitsCompatible(unitA, unitB) {
  if (!unitA || !unitB) return true;
  return unitA.stem === unitB.stem;
}

/* -------------------------------------------------------------------------- */
/* Caveats                                                                    */
/* -------------------------------------------------------------------------- */

const CAVEAT_KIND_ORDER = Object.keys(CAVEAT_MARKERS);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A term becomes a regex with a boundary on whichever side is a word
 * character, so 'approx' does not fire inside 'approximately' and 'no' does
 * not fire inside 'nobody'. Symbol-only terms ('~') get no boundary — there
 * is nothing to be a false substring of.
 */
function termPattern(term) {
  const esc = escapeRegExp(term);
  const startsWord = /^[\p{L}\p{N}]/u.test(term);
  const endsWord = /[\p{L}\p{N}]$/u.test(term);
  const pre = startsWord ? '(?<![\\p{L}\\p{N}])' : '';
  const post = endsWord ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${pre}${esc}${post}`, 'giu');
}

/**
 * Every CAVEAT_MARKERS hit in one sentence, as {kind, term, span} objects
 * ready for makeParsed's `caveats` — `term` is the actual matched source
 * text (casing and all), never the canonical lexicon spelling, so a
 * candidate's caveat reads exactly as the author wrote it.
 *
 * Longer terms are tried first within each kind so 'just under' is not
 * pre-empted by a shorter overlapping term, and a claimed-span list stops
 * the same stretch of text from being counted under two kinds at once.
 */
function findCaveats(sentenceText, offset) {
  const claimed = [];
  const hits = [];
  for (const kind of CAVEAT_KIND_ORDER) {
    const terms = [...CAVEAT_MARKERS[kind]].sort((a, b) => b.length - a.length);
    for (const term of terms) {
      const re = termPattern(term);
      let m;
      while ((m = re.exec(sentenceText)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (end === start) { re.lastIndex += 1; continue; } // guard against a degenerate empty match
        if (claimed.some((c) => start < c.end && end > c.start)) continue;
        claimed.push({ start, end });
        hits.push({ kind, term: m[0], span: { start: offset + start, end: offset + end } });
      }
    }
  }
  hits.sort((a, b) => a.span.start - b.span.start);
  return hits;
}

/* -------------------------------------------------------------------------- */
/* Sentence records                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every sentence in the document, in order, with its quantity/numerator/
 * denominator/unit/caveats resolved and its immediate document-level
 * neighbours attached — but no `ordinal` yet (that depends on which
 * sentences survive filtering, decided by the caller).
 */
function buildSentenceRecords(sourceText) {
  const paragraphs = splitParagraphs(sourceText);
  const flat = [];

  for (const para of paragraphs) {
    const sentences = splitSentences(para.text, para.span.start);
    const paraLocal = [];

    for (const sent of sentences) {
      const allQuantities = parseQuantities(sent.text, sent.span.start);
      const primary = pickPrimary(allQuantities);

      let quantity = null;
      let numerator = null;
      let denominator = null;
      let unit = null;

      if (primary) {
        quantity = primary; // makeQuantity (via makeParsed) reads only the fields it needs
        unit = headNounAfter(sent.text, primary.span, sent.span.start);
        ({ numerator, denominator } = resolveMagnitudes(
          primary, allQuantities, sent.text, sent.span.start, paraLocal, unit
        ));
      }

      const record = {
        text: sent.text,
        span: sent.span,
        quantity,
        numerator,
        denominator,
        unit,
        caveats: findCaveats(sent.text, sent.span.start)
      };
      paraLocal.push(record);
      flat.push(record);
    }
  }

  for (let i = 0; i < flat.length; i += 1) {
    flat[i].prevSpan = i > 0 ? flat[i - 1].span : null;
    flat[i].nextSpan = i < flat.length - 1 ? flat[i + 1].span : null;
  }
  return flat;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every sentence that survives filtering, as `{parsed, prevSpan, nextSpan}`.
 * `parsed` is a contract.js Parsed (via makeParsed); `prevSpan`/`nextSpan`
 * are the immediately preceding/following sentence's span in the SAME
 * document (not paragraph-scoped — a rewrite can hoist a caveat across a
 * paragraph break too), either possibly null at a document boundary.
 *
 * This is the lower-level export mint.js's candidate path needs, since a
 * Candidate carries `neighbours` and a Claim does not (contract.js). Claims
 * only need `.parsed` — see `extractParsed` below.
 *
 * `requireQuantity: true` drops any sentence with no primary quantity before
 * `ordinal` is assigned, so `ordinal` is always contiguous 0-based document
 * order over exactly the sentences returned — never a gap left by a dropped
 * sentence.
 */
export function extractRecords(sourceText, { requireQuantity = false } = {}) {
  const flat = buildSentenceRecords(sourceText);
  const survivors = requireQuantity ? flat.filter((r) => r.quantity !== null) : flat;

  return survivors.map((r, i) => ({
    parsed: makeParsed({
      text: r.text,
      span: r.span,
      ordinal: i,
      quantity: r.quantity,
      numerator: r.numerator,
      denominator: r.denominator,
      unit: r.unit,
      caveats: r.caveats
    }),
    prevSpan: r.prevSpan,
    nextSpan: r.nextSpan
  }));
}

/**
 * Document -> Parsed[]. The shape both mint.js's Claim path and the
 * Candidate path build on; Candidates additionally need the neighbours
 * carried by `extractRecords`.
 */
export function extractParsed(sourceText, opts = {}) {
  return extractRecords(sourceText, opts).map((r) => r.parsed);
}
