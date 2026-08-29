/**
 * quantity.js — parse a numeric expression out of one sentence into a
 * Quantity (+ numerator, denominator, unit), including the precision band that
 * defines how much restatement drift is tolerable.
 *
 * Owns: number/unit/ratio parsing. Depends on: lexicon, text, contract.
 * HARD TIMEBOX (BUILD-PLAN.md +0:35 → +1:20) — the biggest overrun risk.
 *
 * ---------------------------------------------------------------------------
 * TWO CONVENTIONS THAT EVERY OTHER MODULE DEPENDS ON. Read before editing.
 *
 * 1. A PERCENT'S `value` IS A FRACTION. "44%" parses to `0.44`, not `44`.
 *    This is not cosmetic. The demo's headline chain is `0.79% — 2 of 252
 *    dispatches`, and BATON only earns the right to say those two agree if a
 *    percent and a ratio are on the same scale: 2/252 = 0.007937 against
 *    0.79% = 0.0079 is a 0.46% relative difference, which score.js reads as
 *    numerically identical. Store "44" instead and the product's own opening
 *    example stops working. `raw` keeps the surface form ("44%") so diff.js can
 *    quote what the author actually wrote.
 *
 * 2. A HEDGE WIDENS THE BAND AND NEVER MOVES THE VALUE. "over 200" is
 *    `value: 200, band: [200, 300]` — not 250. Writing 250 there would be
 *    inventing a number nobody said, and contract.js's makeQuantity rejects a
 *    value outside its own band anyway. lexicon.js guarantees every hedge
 *    satisfies `lo <= 1 <= hi`, which is what makes that safe.
 *
 * `suppressed` is set HERE rather than in pickPrimary because the evidence for
 * it — the words on either side — is only in scope during parsing. pickPrimary
 * gets a list and a reason, not a sentence it has to re-read.
 */

import {
  HEDGES, HEDGE_MAX_WORDS, VAGUE, CURRENCY, MAGNITUDE, DURATION_UNITS,
  MONTHS, DATE_PREPS, ENUM_MARKERS, HEAD_SKIP, VERB_STOP, STOPWORDS,
  DIMENSION_RANK, stem
} from './lexicon.js';
import { makeQuantity } from './contract.js';

/** A number with optional thousands separators and decimals. */
const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;

const RE = Object.freeze({
  ratioOf: new RegExp(String.raw`(${NUMBER})\s+(?:out\s+of|of|in)\s+(?:the\s+|every\s+)?(${NUMBER})`, 'gi'),
  ratioSlash: new RegExp(String.raw`(${NUMBER})\s*/\s*(${NUMBER})`, 'g'),
  percent: new RegExp(String.raw`(${NUMBER})\s*(%|percent|per\s*cent|pct)`, 'gi'),
  currencySym: new RegExp(String.raw`([$€£¥₹])\s*(${NUMBER})\s*(k|m|mn|bn|b|t|tn|thousand|million|billion|trillion)?\b`, 'gi'),
  currencyCode: new RegExp(String.raw`\b(usd|eur|gbp|inr|jpy)\s*(${NUMBER})\s*(k|m|mn|bn|b|t|tn|thousand|million|billion|trillion)?\b`, 'gi'),
  duration: new RegExp(String.raw`(${NUMBER})\s*-?\s*(ms|milliseconds?|secs?|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|quarters?|years?|yrs?)\b`, 'gi'),
  vague: new RegExp(String.raw`\b(${[...VAGUE.keys()].join('|')})\b`, 'gi'),
  bare: new RegExp(String.raw`(?<![\d.,])(${NUMBER})`, 'g')
});

/** Priority order. A lower number wins an overlap — most specific first. */
const PRIORITY = Object.freeze(['ratio', 'percent', 'currency', 'duration', 'vague', 'bare']);

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every quantity mention in one sentence, left to right.
 *
 * Each mention is a contract.js Quantity (validated by makeQuantity, so a band
 * bug throws here rather than surfacing as a wrong finding on stage) plus:
 *   - `numerator` / `denominator`: makeMagnitude inputs, or null. Present for
 *     ratios, which is what feeds the denominator_loss class.
 *   - `hedge`: the hedge term that widened the band, or null.
 *   - `suppressed`: why pickPrimary must not choose this one, or null.
 *
 * @param {string} sentence  The sentence text.
 * @param {number} offset    Where `sentence` starts in the source document.
 */
export function parseQuantities(sentence, offset = 0) {
  const claimed = [];
  const found = [];

  for (const kind of PRIORITY) {
    for (const hit of matchKind(kind, sentence)) {
      if (claimed.some((c) => hit.start < c.end && hit.end > c.start)) continue;
      claimed.push({ start: hit.start, end: hit.end });
      found.push(hit);
    }
  }

  found.sort((a, b) => a.start - b.start || a.end - b.end);
  return found.map((hit) => finalise(hit, sentence, offset));
}

/**
 * The sentence's MAIN quantity, or null.
 *
 * Applies, in order: drop anything parsing already flagged as a date, an
 * enumeration, an ordinal or a list marker; then prefer by dimension
 * (percent > ratio > currency > duration > count > dimensionless); then take
 * the leftmost. Returning null is a legitimate answer — contract.js lets a
 * Candidate carry `quantity: null`, and that is what earns the `no_quantity`
 * receipt rather than a fabricated match.
 */
export function pickPrimary(quantities) {
  if (!Array.isArray(quantities) || quantities.length === 0) return null;
  const live = quantities.filter((q) => !q.suppressed);
  if (live.length === 0) return null;

  let best = null;
  for (const q of live) {
    if (best === null) { best = q; continue; }
    const dq = DIMENSION_RANK[q.dimension] ?? 0;
    const db = DIMENSION_RANK[best.dimension] ?? 0;
    if (dq > db) best = q;
    // equal rank: leftmost wins, and `live` is already in span order
  }
  return best;
}

/**
 * The head noun a quantity is counting: the `unit` half of unit_drift.
 *
 * Skips determiners and nested numerals ("44% of the 289 dispatches" →
 * "dispatches"), then returns null if what remains is a stopword or a verb.
 * "44% failed" names no unit, and saying it does would make "44% failed" and
 * "60% failed" look like they share one — the coincidental agreement the unit
 * channel exists to rule out.
 *
 * @returns {{term: string, stem: string, span: {start,end}}|null}
 *          A makeUnitRef input, ready to hand to contract.js.
 */
export function headNounAfter(sentence, quantitySpan, offset = 0) {
  if (!quantitySpan) return null;
  let from = quantitySpan.end - offset;
  if (from < 0 || from > sentence.length) return null;

  const re = /[\p{L}\p{N}][\p{L}\p{N}%$€£¥₹.,/=_-]*/gu;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    const raw = m[0].replace(/[.,/=_-]+$/, '');
    if (raw.length === 0) continue;
    const lower = raw.toLowerCase();

    if (HEAD_SKIP.has(lower)) continue;
    if (/^[\d.,]+$/.test(raw)) continue; // nested numeral: the 289 in "of the 289 dispatches"
    if (/^[\d.,]+%$/.test(raw)) continue;

    if (STOPWORDS.has(lower) || VERB_STOP.has(lower)) return null;
    const st = stem(raw);
    if (st === '') return null;
    return { term: raw, stem: st, span: { start: offset + m.index, end: offset + m.index + raw.length } };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

function* matchKind(kind, s) {
  switch (kind) {
    case 'ratio':
      yield* ratios(s);
      break;
    case 'percent':
      yield* simple(RE.percent, s, (m) => ({
        dimension: 'percent',
        value: num(m[1]) / 100,
        precision: decimals(m[1])
      }));
      break;
    case 'currency':
      yield* simple(RE.currencySym, s, (m) => ({
        dimension: 'currency',
        value: num(m[2]) * magnitude(m[3]),
        precision: decimals(m[2]),
        currency: CURRENCY.get(m[1].toLowerCase()) ?? null
      }));
      yield* simple(RE.currencyCode, s, (m) => ({
        dimension: 'currency',
        value: num(m[2]) * magnitude(m[3]),
        precision: decimals(m[2]),
        currency: CURRENCY.get(m[1].toLowerCase()) ?? null
      }));
      break;
    case 'duration':
      yield* simple(RE.duration, s, (m) => ({
        dimension: 'duration',
        value: num(m[1]) * (DURATION_UNITS.get(m[2].toLowerCase()) ?? 1),
        precision: decimals(m[1])
      }));
      break;
    case 'vague':
      yield* vagues(s);
      break;
    case 'bare':
      yield* simple(RE.bare, s, (m) => ({
        dimension: 'count', // refined to `dimensionless` in finalise() when no head noun follows
        value: num(m[1]),
        precision: decimals(m[1])
      }));
      break;
    default:
      break;
  }
}

function* simple(re, s, build) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const core = build(m);
    if (core.value === null || !Number.isFinite(core.value)) continue;
    yield { ...core, raw: m[0], start: m.index, end: m.index + m[0].length, vague: false };
  }
}

function* ratios(s) {
  for (const re of [RE.ratioOf, RE.ratioSlash]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = num(m[1]);
      const d = num(m[2]);
      if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) continue;
      // "2/17" inside a date or a version string is not a ratio; a denominator
      // smaller than its numerator usually means we are looking at neither.
      if (n > d) continue;
      yield {
        raw: m[0],
        start: m.index,
        end: m.index + m[0].length,
        dimension: 'ratio',
        value: n / d,
        precision: 0,
        vague: false,
        numeratorRaw: { value: n, at: m.index + m[0].indexOf(m[1]), len: m[1].length },
        denominatorRaw: { value: d, at: m.index + m[0].lastIndexOf(m[2]), len: m[2].length }
      };
    }
  }
}

function* vagues(s) {
  RE.vague.lastIndex = 0;
  let m;
  while ((m = RE.vague.exec(s)) !== null) {
    const spec = VAGUE.get(m[1].toLowerCase());
    if (!spec) continue;
    yield {
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
      dimension: 'ratio',
      value: spec.value,
      precision: 0,
      vague: true,
      vagueBand: [spec.lo, spec.hi]
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Finalising one mention                                                     */
/* -------------------------------------------------------------------------- */

function finalise(hit, sentence, offset) {
  const hedge = hedgeBefore(sentence, hit.start);
  const start = hedge ? hedge.start : hit.start;
  const raw = sentence.slice(start, hit.end);

  // Band: exact tokens get [value, value] (contract.js), vague words get their
  // licensed range, and a hedge multiplies whichever of those two applies.
  let lo = hit.vague ? hit.vagueBand[0] : hit.value;
  let hi = hit.vague ? hit.vagueBand[1] : hit.value;
  if (hedge) {
    lo *= hedge.lo;
    hi *= hedge.hi;
  }

  let dimension = hit.dimension;
  const span = { start: offset + start, end: offset + hit.end };

  // A bare number counts something only if it names what it counts.
  if (dimension === 'count' && headNounAfter(sentence, span, offset) === null) {
    dimension = 'dimensionless';
  }

  // Round the value with the SAME function as the band. Rounding only the
  // bounds put `lo` above `value` for any repeating fraction (2/17 = 0.1176…),
  // and contract.js rightly threw. Both must go through one rounding, which
  // decision 5 wants anyway: an unrounded float would put the last bits of
  // IEEE noise into the JSON that packages/sign signs.
  const quantity = makeQuantity({
    raw,
    value: round12(hit.value),
    dimension,
    vague: hit.vague,
    band: [round12(lo), round12(hi)],
    precision: hit.precision,
    span
  }, `parseQuantities("${raw}")`);

  return {
    ...quantity,
    numerator: hit.numeratorRaw
      ? { value: hit.numeratorRaw.value, unit: null, unitStem: null, provenance: 'explicit', span: { start: offset + hit.numeratorRaw.at, end: offset + hit.numeratorRaw.at + hit.numeratorRaw.len } }
      : null,
    denominator: hit.denominatorRaw
      ? { value: hit.denominatorRaw.value, unit: null, unitStem: null, provenance: 'explicit', span: { start: offset + hit.denominatorRaw.at, end: offset + hit.denominatorRaw.at + hit.denominatorRaw.len } }
      : null,
    currency: hit.currency ?? null,
    hedge: hedge ? hedge.term : null,
    suppressed: suppression(hit, sentence)
  };
}

/**
 * The hedge phrase immediately before `at`, or null. Longest phrase wins, so
 * "just under" beats "under".
 */
function hedgeBefore(sentence, at) {
  const before = sentence.slice(0, at);

  // A glued tilde: "~44%".
  const tilde = /~\s*$/.exec(before);
  if (tilde) {
    const h = HEDGES.get('~');
    return { term: '~', lo: h.lo, hi: h.hi, start: tilde.index };
  }

  const words = [];
  const wre = /[\p{L}~]+/gu;
  let m;
  while ((m = wre.exec(before)) !== null) words.push({ w: m[0].toLowerCase(), at: m.index, end: m.index + m[0].length });
  if (words.length === 0) return null;
  // Only a hedge that actually abuts the number counts.
  if (before.slice(words[words.length - 1].end).trim() !== '') return null;

  for (let n = Math.min(HEDGE_MAX_WORDS, words.length); n >= 1; n -= 1) {
    const slice = words.slice(words.length - n);
    const phrase = slice.map((x) => x.w).join(' ');
    const h = HEDGES.get(phrase);
    if (h) return { term: phrase, lo: h.lo, hi: h.hi, start: slice[0].at };
  }
  return null;
}

/**
 * Why pickPrimary must skip this mention, or null.
 *
 * These are the four ways a number in prose is not a measurement. Each one is
 * cheap to check here and impossible to check later.
 */
function suppression(hit, sentence) {
  const before = sentence.slice(0, hit.start);
  const prev = lastWord(before);
  const after = sentence.slice(hit.end);
  const next = firstWord(after);

  // (1) A year: four digits beside a month name or a date preposition.
  if (/^\d{4}$/.test(hit.raw) && hit.value >= 1900 && hit.value <= 2099) {
    if (MONTHS.has(prev) || DATE_PREPS.has(prev) || MONTHS.has(next)) return 'date';
  }

  // (2) An ordinal: "44th", "3rd".
  if (/^(st|nd|rd|th)\b/i.test(after)) return 'ordinal';

  // (3) An enumeration: "Figure 3", "Section 2", "v1".
  if (ENUM_MARKERS.has(prev)) return 'enumeration';

  // (4) A list marker or section number opening the sentence: "3. The rate…".
  if (before.trim() === '' && /^\s*[.)\]]/.test(after)) return 'list_marker';

  return null;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function num(s) {
  const v = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(v) ? v : NaN;
}

function decimals(s) {
  const dot = String(s).indexOf('.');
  return dot === -1 ? 0 : String(s).length - dot - 1;
}

function magnitude(suffix) {
  if (!suffix) return 1;
  return MAGNITUDE.get(suffix.toLowerCase()) ?? 1;
}

/** Kill float noise so two runs over the same bytes produce the same JSON. */
function round12(x) {
  return Number.isFinite(x) ? Number(x.toFixed(12)) : x;
}

function lastWord(s) {
  const m = /([\p{L}\p{N}]+)[^\p{L}\p{N}]*$/u.exec(s);
  return m ? m[1].toLowerCase() : '';
}

function firstWord(s) {
  const m = /^[^\p{L}\p{N}]*([\p{L}\p{N}]+)/u.exec(s);
  return m ? m[1].toLowerCase() : '';
}
