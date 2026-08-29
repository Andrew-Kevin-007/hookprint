/**
 * score.js — the three alignment channels for one (claim, candidate) pair:
 * NUM (numeric compatibility, NOT numeric equality), LEX (surviving content
 * words), POS (ordinal agreement) — and their combination into one score.
 *
 * Owns: pair scoring. Depends on: lexicon, text, contract.
 * Never require numeric agreement: value drift is a corruption class.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO CHANNELS AND NOT ONE.
 *
 * You cannot re-identify a downstream restatement by matching its number,
 * because the claims we most need to catch are exactly the ones whose number
 * MOVED. If 44 became 60, an aligner that requires numeric agreement calls it
 * `unaligned` and the headline finding becomes unreachable — contract.js
 * decision 3, and the whole reason version (i) was refused in BUILD-PLAN.md.
 *
 * So NUM and LEX are independent. NUM answers "could these be the same
 * measurement?" and goes to zero the moment the number genuinely moved. LEX
 * answers "is this sentence talking about the same thing?" from context, anchor
 * and unit alone — no embeddings, no model, no network, so the checker still
 * runs with the network off.
 *
 * The VALUE-DRIFT LANE is what joins them: a pair with a dead NUM and a very
 * strong LEX is not a non-match, it is the corruption. Deleting that lane
 * silently deletes `value_drift` from the product.
 *
 * The constants below are load-bearing and were validated against the worked
 * example in tests/score.test.js. Change one and re-run that table.
 */

import { dimensionsConflict } from './lexicon.js';
import { tokenize, contentStems, trigrams, dice, stem } from './text.js';
import { pickPrimary, parseQuantities, headNounAfter } from './quantity.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Channel weights. NUM and LEX are equals on purpose — see the header. */
export const W = Object.freeze({ NUM: 0.45, LEX: 0.45, POS: 0.10 });

/** Sub-weights inside LEX. Context dominates; the unit is a tie-breaker. */
export const LEXW = Object.freeze({ context: 0.62, anchor: 0.23, unit: 0.15 });

/** Both channels agreeing is worth more than the sum of the two. */
export const AGREE_BONUS = 0.08;

/** LEX at or above this is strong enough to carry a match on its own. */
export const LEX_STRONG = 0.66;

/** Below this, we do not claim a match. */
export const ACCEPT = 0.52;

/** A win by less than this over the runner-up claim is not a win. */
export const MARGIN = 0.07;

/** Enough to attach as a supporting fragment, not enough to own the claim. */
export const SUPPORT = 0.60;

const EPS = 1e-12;

/* -------------------------------------------------------------------------- */
/* Profiles                                                                   */
/* -------------------------------------------------------------------------- */

const PROFILES = new WeakMap();

/**
 * The scoreable view of a Claim, a Candidate, or a bare string.
 *
 * Cached per object: the score matrix is |claims| x |candidates|, and
 * re-tokenising both sides inside that loop is the difference between a report
 * in milliseconds and a report a judge waits for.
 *
 * The primary quantity's span is excluded from the context bag, and purely
 * numeric tokens are dropped by text.js. That is deliberate: letting the number
 * into the LEXICAL channel would reintroduce "align on the number" through the
 * side door, and the drift lane would stop working without anyone noticing.
 */
export function profile(x) {
  if (typeof x === 'string') return buildProfile({ text: x, ordinal: 0 });
  const cached = PROFILES.get(x);
  if (cached) return cached;
  const p = buildProfile(x);
  PROFILES.set(x, p);
  return p;
}

function buildProfile(x) {
  const text = String(x.text ?? '');
  const tokens = tokenize(text, 0);

  // Prefer the quantity/unit the caller already parsed (extract.js has done this
  // once, with more context than we have); parse only as a fallback.
  const quantity = x.quantity !== undefined ? x.quantity : pickPrimary(parseQuantities(text, 0));
  const qSpanLocal = localSpan(quantity, x);

  const unit = x.unit !== undefined && x.unit !== null
    ? x.unit
    : (quantity ? headNounAfter(text, qSpanLocal ?? quantity.span, 0) : null);

  const bag = contentStems(tokens, qSpanLocal ? [qSpanLocal] : []);
  const unitStem = unitStemOf(unit);

  return {
    text,
    tokens,
    quantity: quantity ?? null,
    unit: unitStem,
    // The unit gets its own weighted channel, so it must not also be counted in
    // the context bag — that would pay for the same evidence twice.
    bag: unitStem ? bag.filter((s) => s !== unitStem) : bag,
    ordinal: Number.isInteger(x.ordinal) ? x.ordinal : 0,
    normOrdinal: typeof x.normOrdinal === 'number' ? x.normOrdinal : 0
  };
}

/**
 * A Claim's span is absolute in its source file; a profile tokenises the
 * sentence alone. Re-base the quantity span onto the local text so the two
 * agree, and give up rather than guess if it does not fit.
 */
function localSpan(quantity, x) {
  if (!quantity || !quantity.span) return null;
  const base = x.span && Number.isInteger(x.span.start) ? x.span.start : 0;
  const start = quantity.span.start - base;
  const end = quantity.span.end - base;
  if (start < 0 || end < start) return null;
  return { start, end };
}

function unitStemOf(unit) {
  if (!unit) return null;
  if (typeof unit === 'string') return stem(unit) || null;
  if (typeof unit.stem === 'string' && unit.stem) return unit.stem;
  if (typeof unit.term === 'string') return stem(unit.term) || null;
  return null;
}

/* -------------------------------------------------------------------------- */
/* IDF                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Build the IDF table from the ORIGIN claim set, once per run.
 *
 * `idf(stem) = ln((N+1)/(df(stem)+1)) + 1`.
 *
 * A stem never seen in the origin set is clamped to the MEDIAN origin IDF, not
 * the maximum. That choice matters: an unseen stem is a word we know nothing
 * about, and giving it the maximum weight would let any candidate inflate its
 * own score just by using rare vocabulary the claims never used. The median
 * says "assume it is as informative as a typical word", which is the honest
 * prior.
 */
export function buildIdf(origins) {
  const df = new Map();
  const bags = origins.map((o) => profile(o).bag);
  for (const bag of bags) {
    for (const s of new Set(bag)) df.set(s, (df.get(s) ?? 0) + 1);
  }
  const N = bags.length;
  const weights = new Map();
  for (const [s, d] of df) weights.set(s, Math.log((N + 1) / (d + 1)) + 1);

  const sorted = [...weights.values()].sort((a, b) => a - b);
  const median = sorted.length === 0
    ? 1
    : (sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

  return {
    N,
    df,
    median,
    weight(s) { return weights.get(s) ?? median; },
    anchorCache: new WeakMap()
  };
}

/** The neutral table used when a caller scores one pair with no corpus. */
export function flatIdf() {
  return { N: 0, df: new Map(), median: 1, weight() { return 1; }, anchorCache: new WeakMap() };
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The hard veto: currency / percent / duration may not describe each other.
 * Checked before anything else, so no amount of lexical similarity can talk its
 * way past it. `$44M of spend` scores exactly zero against `44% of dispatches`.
 */
export function dimensionVeto(qA, qB) {
  if (!qA || !qB) return false;
  return dimensionsConflict(qA.dimension, qB.dimension);
}

/**
 * Could these two be the same measurement? NOT: are they the same number.
 *
 * Returns 0 when the origin's number genuinely moved, which is precisely when
 * the drift lane in `scorePair` takes over.
 */
export function numericCompat(a, b) {
  if (!a || !b) return 0;
  if (dimensionsConflict(a.dimension, b.dimension)) return 0;
  if (a.value === null || b.value === null) return bandTier(a.band, b.band) ? 0.92 : 0;

  let best = 0;
  for (const [va, bandA] of scaleVariants(a, b)) {
    best = Math.max(best, tier(va, b.value, bandA, b.band));
    if (best === 1) break;
  }
  return best;
}

/**
 * A bare number may be the restatement of a percent with the unit dropped —
 * `unit_drift`/`unit_dropped`, a class we must be able to see. So when one side
 * is dimensionless, try it at its face value and at both hundred-fold scales
 * and keep the best reading. Only `dimensionless` gets this: a `count` of 289
 * is not a percent of 2.89.
 */
function scaleVariants(a, b) {
  const out = [[a.value, a.band]];
  if (a.dimension === 'dimensionless' || b.dimension === 'dimensionless') {
    for (const f of [1 / 100, 100]) {
      out.push([a.value * f, [scaleBound(a.band[0], f), scaleBound(a.band[1], f)]]);
    }
  }
  return out;
}

function scaleBound(x, f) {
  return x === null ? null : x * f;
}

function tier(va, vb, bandA, bandB) {
  const rel = Math.abs(va - vb) / Math.max(Math.abs(va), Math.abs(vb), EPS);
  if (rel <= 0.005) return 1.00;
  if (bandTier(bandA, bandB)) return 0.92;
  if (rel <= 0.02) return 0.75;
  if (rel <= 0.10) return 0.45;
  if (digitsOf(va) === digitsOf(vb)) return 0.35; // 12 vs 21, 4.4 vs 44, 0.79 vs 79
  return 0;
}

/** Do two bands overlap? A null bound is unbounded on that side. */
function bandTier(bandA, bandB) {
  if (!bandA || !bandB) return false;
  const loA = bandA[0] ?? -Infinity;
  const hiA = bandA[1] ?? Infinity;
  const loB = bandB[0] ?? -Infinity;
  const hiB = bandB[1] ?? Infinity;
  return loA <= hiB && loB <= hiA;
}

/**
 * The sorted significant digits of a number: 4.4 and 44 both give "44", 12 and
 * 21 both give "12". This is the transposition/decimal-slip tier, and it is
 * deliberately narrow — 60 and 44 share no digits and must score zero, or the
 * drift lane never fires.
 */
function digitsOf(x) {
  const v = Math.abs(x);
  if (!Number.isFinite(v) || v === 0) return '0';
  let s = v.toPrecision(12);
  if (s.includes('e')) s = v.toFixed(0);
  s = s.replace('.', '').replace(/0+$/, '').replace(/^0+/, '');
  return s === '' ? '0' : s.split('').sort().join('');
}

/**
 * IDF-weighted cosine over two stemmed content bags. The unit term is already
 * out of both bags (see `buildProfile`) so it cannot be paid for twice.
 *
 * An empty bag scores 0 against anything. That is "no evidence", and it is the
 * honest answer — see the bare-quantity lane in `scorePair` for what happens
 * when a candidate has no lexical evidence at all.
 */
export function cosineIdf(bagA, bagB, idf) {
  const tfA = counts(bagA);
  const tfB = counts(bagB);
  if (tfA.size === 0 || tfB.size === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [s, n] of tfA) {
    const w = n * idf.weight(s);
    normA += w * w;
    const m = tfB.get(s);
    if (m !== undefined) dot += w * (m * idf.weight(s));
  }
  for (const [s, n] of tfB) {
    const w = n * idf.weight(s);
    normB += w * w;
  }
  if (normA === 0 || normB === 0) return 0;
  return Number(clamp01(dot / (Math.sqrt(normA) * Math.sqrt(normB))).toFixed(12));
}

function counts(bag) {
  const m = new Map();
  for (const s of bag) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
}

/**
 * The anchor set: the tokens that identify a claim rather than describe it.
 *
 * Capitalised mid-sentence tokens (names), tokens carrying digits or hyphens
 * (identifiers, versions, `n=252`), and the two rarest content stems. Rare
 * stems are the ones a paraphrase is least likely to have replaced, which is
 * why they earn their own channel rather than being left to the cosine.
 */
export function anchorsOf(p, idf) {
  const cached = idf.anchorCache.get(p);
  if (cached) return cached;

  const set = new Set();
  for (const t of p.tokens) {
    if (t.capitalised && !t.first && !t.stop) set.add(normaliseAnchor(t.raw));
    else if (t.hasDigit || t.raw.includes('-')) set.add(normaliseAnchor(t.raw));
  }
  const rare = [...new Set(p.bag)]
    .map((s) => ({ s, w: idf.weight(s), at: p.bag.indexOf(s) }))
    .sort((a, b) => b.w - a.w || a.at - b.at) // rarest first; ties keep source order
    .slice(0, 2);
  for (const r of rare) set.add(r.s);

  set.delete('');
  idf.anchorCache.set(p, set);
  return set;
}

/** `44%` and `44` are the same anchor; `self-reported` keeps its hyphen. */
function normaliseAnchor(raw) {
  return raw.toLowerCase().replace(/^[^a-z0-9-]+/, '').replace(/[^a-z0-9-]+$/, '');
}

/**
 * Unit similarity. Equal stems are 1; otherwise character trigrams, which catch
 * `dispatch`/`dispatches` and `record`/`records` without catching
 * `dispatch`/`agent`. Absent on either side is 0 — no evidence is not agreement.
 */
export function unitSim(unitA, unitB) {
  const a = unitStemOf(unitA);
  const b = unitStemOf(unitB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return dice(trigrams(a), trigrams(b));
}

/* -------------------------------------------------------------------------- */
/* The pair score                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Score one (origin, candidate) pair in [0, 1], with its channels.
 *
 * @param {Object} origin     A Claim, a profile, or a bare sentence string.
 * @param {Object} candidate  A Candidate, a profile, or a bare sentence string.
 * @param {Object} idf        From `buildIdf(origins)`, or `flatIdf()`.
 */
export function scorePair(origin, candidate, idf = flatIdf()) {
  const A = profile(origin);
  const B = profile(candidate);

  if (dimensionVeto(A.quantity, B.quantity)) {
    return { score: 0, NUM: 0, LEX: 0, POS: 0, veto: true, lane: 'dimension_veto' };
  }

  const NUM = numericCompat(A.quantity, B.quantity);
  const context = cosineIdf(A.bag, B.bag, idf);
  const anchorA = anchorsOf(A, idf);
  const anchorB = anchorsOf(B, idf);
  const anchor = dice(anchorA, anchorB);
  const unit = unitSim(A.unit, B.unit);
  const LEX = clamp01(LEXW.context * context + LEXW.anchor * anchor + LEXW.unit * unit);
  const POS = 1 - Math.min(1, Math.abs(A.normOrdinal - B.normOrdinal) / 0.5);

  let raw = W.NUM * NUM + W.LEX * LEX + W.POS * POS;
  let lane = 'base';

  if (NUM >= 0.80 && LEX >= 0.35) {
    raw += AGREE_BONUS;
    lane = 'agreement';
  }

  // VALUE-DRIFT LANE. The number moved and the sentence did not. This is the
  // corruption, not a non-match, and without this lane `value_drift` is
  // unreachable — see the header and contract.js decision 3.
  if (NUM < 0.25 && LEX >= LEX_STRONG) {
    const lifted = 0.50 + 0.45 * ((LEX - LEX_STRONG) / (1 - LEX_STRONG));
    if (lifted > raw) {
      raw = lifted;
      lane = 'value_drift';
    }
  }

  // BARE-QUANTITY LANE. A candidate that is nothing but a quantity — "nearly
  // half", "roughly 44%" — offers no lexical evidence at all. That is ABSENT
  // evidence, not conflicting evidence, and scoring it as zero similarity is
  // the same mistake as calling a drifted number unmatched: it makes a real
  // restatement form unreachable. When there is no measurable lexical signal
  // and the numbers are compatible, fall back to the numeric channel alone,
  // discounted so such a pair always ranks below one with real evidence.
  if (NUM >= 0.90 && !measurableLex(A, B, anchorA, anchorB)) {
    const floor = 0.50 + 0.08 * NUM;
    if (floor > raw) {
      raw = floor;
      lane = 'bare_quantity';
    }
  }

  // Round every emitted number. These land in an Alignment, which goes into the
  // Report that packages/sign signs, and an unrounded cosine carries the last
  // bits of IEEE noise into that signature for no benefit (contract.js
  // decision 5). Twelve places is far below any threshold gap here.
  return {
    score: r12(clamp01(raw)),
    NUM: r12(NUM),
    LEX: r12(LEX),
    POS: r12(POS),
    context: r12(context),
    anchor: r12(anchor),
    unit: r12(unit),
    veto: false,
    lane
  };
}

function r12(x) {
  return Number.isFinite(x) ? Number(x.toFixed(12)) : 0;
}

/** True when at least one lexical sub-signal had evidence on BOTH sides. */
function measurableLex(A, B, anchorA, anchorB) {
  if (A.bag.length > 0 && B.bag.length > 0) return true;
  if (anchorA.size > 0 && anchorB.size > 0) return true;
  return Boolean(A.unit && B.unit);
}

export function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
