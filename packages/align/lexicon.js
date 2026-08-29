/**
 * lexicon.js — the only place vocabulary lives: stopwords, stemming, unit
 * synonyms, and the hedge / scope / condition / temporal / uncertainty /
 * comparison-basis term lists that become caveats.
 *
 * Owns: word lists and `stem()`. Depends on: nothing.
 *
 * ---------------------------------------------------------------------------
 * DATA ONLY. The one piece of logic here is `stem()`, because a word list and
 * the normaliser that decides whether a word IS in it cannot live in different
 * files without eventually disagreeing.
 *
 * Read contract.js decision 3 before changing anything below. BATON must never
 * align a downstream restatement to its origin BY MATCHING THE NUMBER: a claim
 * whose number drifted (44 -> 60) must still align, because that drift is the
 * corruption we exist to detect. The lexical channel therefore carries the
 * identification load, and it is built entirely out of the tables in this file
 * — no embeddings, no model, no network.
 *
 * Dimension names below are contract.js's DIMENSIONS, not BUILD-PLAN.md's:
 * `currency` (not "money") and `dimensionless` (not "plain"). makeQuantity
 * throws on anything else, so this file must not invent its own spelling.
 */

/* -------------------------------------------------------------------------- */
/* Stopwords                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * True function words only.
 *
 * Deliberately NOT a "weak word" list. Reporting verbs (`reported`, `showed`)
 * and change verbs (`rose`, `fell`) stay in the context bag and are discounted
 * by IDF instead — a corpus where every claim says "reported" gives that stem a
 * low IDF automatically, which is more honest than a hand-curated ban and
 * survives a corpus that does not look like the one we tuned on.
 */
export const STOPWORDS = Object.freeze(new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'as', 'so',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'into', 'onto',
  'across', 'through', 'between', 'per',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
  'has', 'have', 'had', 'having',
  'do', 'does', 'did', 'doing',
  'will', 'would', 'shall', 'should', 'can', 'could', 'must',
  'this', 'that', 'these', 'those', 'it', 'its', 'their', 'them', 'they',
  'our', 'ours', 'we', 'us', 'you', 'your', 'he', 'she', 'his', 'her',
  'there', 'here', 'when', 'where', 'which', 'who', 'whom', 'whose', 'what',
  'any', 'both', 'each', 'other', 'such', 'only',
  'own', 'same', 'also', 'very', 'not', 'no', 'nor', 'too', 'out', 'up',
  'down', 'again', 'further', 'while', 'because', 'until'
]));

/**
 * Verbs that must never be taken as the HEAD NOUN of a quantity.
 *
 * `headNounAfter` walks forward from a quantity looking for the thing being
 * counted. In "44% failed" the next token is a verb and the honest answer is
 * that this sentence names no unit — returning "failed" would make "44% failed"
 * and "60% failed" appear to share a unit for no reason other than both being
 * failures, which is exactly the coincidental agreement the unit channel exists
 * to rule out.
 *
 * This list is NOT applied to the context bag. See STOPWORDS.
 */
export const VERB_STOP = Object.freeze(new Set([
  'failed', 'fail', 'fails', 'failing',
  'dropped', 'drop', 'drops', 'dropping',
  'rose', 'rise', 'rises', 'rising', 'risen',
  'fell', 'fall', 'falls', 'falling', 'fallen',
  'increased', 'increase', 'increases', 'increasing',
  'decreased', 'decrease', 'decreases', 'decreasing',
  'hit', 'hits', 'hitting',
  'reached', 'reach', 'reaches', 'reaching',
  'exceeded', 'exceed', 'exceeds', 'exceeding',
  'remained', 'remain', 'remains', 'remaining',
  'occurred', 'occur', 'occurs', 'occurring',
  'showed', 'show', 'shows', 'showing', 'shown',
  'reported', 'report', 'reports', 'reporting',
  'was', 'were', 'is', 'are', 'be', 'been', 'being', 'am',
  'had', 'has', 'have', 'having',
  'said', 'says', 'say', 'saying',
  'grew', 'grow', 'grows', 'growing', 'grown',
  'went', 'go', 'goes', 'going', 'gone',
  'came', 'come', 'comes', 'coming',
  'agreed', 'agree', 'agrees', 'agreeing',
  'carried', 'carry', 'carries', 'carrying',
  'represents', 'represented', 'representing',
  'appears', 'appear', 'appeared', 'seems', 'seem', 'seemed',
  'suggests', 'suggest', 'suggested', 'indicates', 'indicate', 'indicated'
]));

/* -------------------------------------------------------------------------- */
/* Hedges                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Multiplicative uncertainty bands.
 *
 * "roughly 44%" is not the number 44 — it is a band around 44 that a faithful
 * restatement is allowed to land anywhere inside. Composing these onto a parsed
 * value is what lets "nearly half" and "44%" be numerically compatible without
 * either of them being wrong.
 *
 * INVARIANT: every entry satisfies `lo <= 1 <= hi`. quantity.js multiplies the
 * BAND by these and leaves `value` alone, so this invariant is what guarantees
 * the composed band still contains its own value — which contract.js's
 * makeQuantity enforces and would otherwise throw on. A hedge is a statement
 * about tolerance, never a licence to move the number.
 *
 * `kind` maps onto contract.js CAVEAT_KINDS for the caveat_loss class.
 */
export const HEDGES = Object.freeze(new Map(Object.entries({
  roughly: { lo: 0.90, hi: 1.10, kind: 'hedge' },
  about: { lo: 0.90, hi: 1.10, kind: 'hedge' },
  around: { lo: 0.90, hi: 1.10, kind: 'hedge' },
  approximately: { lo: 0.90, hi: 1.10, kind: 'hedge' },
  approx: { lo: 0.90, hi: 1.10, kind: 'hedge' },
  circa: { lo: 0.90, hi: 1.10, kind: 'hedge' },
  '~': { lo: 0.90, hi: 1.10, kind: 'hedge' },

  nearly: { lo: 0.85, hi: 1.00, kind: 'hedge' },
  almost: { lo: 0.85, hi: 1.00, kind: 'hedge' },
  'just under': { lo: 0.85, hi: 1.00, kind: 'hedge' },
  'close to': { lo: 0.85, hi: 1.00, kind: 'hedge' },
  'up to': { lo: 0.50, hi: 1.00, kind: 'hedge' },

  over: { lo: 1.00, hi: 1.50, kind: 'hedge' },
  'more than': { lo: 1.00, hi: 1.50, kind: 'hedge' },
  'greater than': { lo: 1.00, hi: 1.50, kind: 'hedge' },
  'at least': { lo: 1.00, hi: 1.50, kind: 'hedge' },
  'north of': { lo: 1.00, hi: 1.50, kind: 'hedge' },
  'just over': { lo: 1.00, hi: 1.15, kind: 'hedge' },

  under: { lo: 0.60, hi: 1.00, kind: 'hedge' },
  'less than': { lo: 0.60, hi: 1.00, kind: 'hedge' },
  'fewer than': { lo: 0.60, hi: 1.00, kind: 'hedge' },
  'at most': { lo: 0.60, hi: 1.00, kind: 'hedge' },
  below: { lo: 0.60, hi: 1.00, kind: 'hedge' }
})));

/** Longest hedge phrase, in words. Bounds the backward scan in quantity.js. */
export const HEDGE_MAX_WORDS = 2;

/* -------------------------------------------------------------------------- */
/* Vague quantifiers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Words that carry a proportion without carrying a number.
 *
 * These become full quantities: `dimension: 'ratio'`, `vague: true`, and a band
 * wide enough to be honest about what the word actually licenses. "most"
 * spanning [0.50, 0.95] is not laziness — anyone writing "most" has licensed
 * every value in that range, so a downstream "88%" is NOT drift and BATON must
 * not say it is. The false positive is the expensive failure on stage.
 */
export const VAGUE = Object.freeze(new Map(Object.entries({
  half: { value: 0.50, lo: 0.40, hi: 0.60 },
  halves: { value: 0.50, lo: 0.40, hi: 0.60 },
  third: { value: 0.333, lo: 0.28, hi: 0.40 },
  thirds: { value: 0.667, lo: 0.60, hi: 0.72 },
  quarter: { value: 0.25, lo: 0.20, hi: 0.30 },
  quarters: { value: 0.75, lo: 0.70, hi: 0.80 },
  most: { value: 0.65, lo: 0.50, hi: 0.95 },
  majority: { value: 0.60, lo: 0.50, hi: 0.95 },
  minority: { value: 0.30, lo: 0.05, hi: 0.49 },
  few: { value: 0.08, lo: 0.01, hi: 0.20 },
  several: { value: 0.15, lo: 0.03, hi: 0.35 },
  many: { value: 0.45, lo: 0.20, hi: 0.80 }
})));

/* -------------------------------------------------------------------------- */
/* Caveats                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Caveat markers, keyed by contract.js CAVEAT_KINDS.
 *
 * A caveat present at hop 1 and gone at hop 3 is the `caveat_loss` class.
 * Grouping by kind is what lets a delta say WHICH qualifier was dropped, and
 * lets a caveat that was HOISTED into a neighbouring sentence be recognised as
 * still present rather than reported as stripped — verification test #12, the
 * likeliest false positive in the system.
 *
 * Multi-word entries are matched as phrases; single words are matched on the
 * stemmed token. Ordering inside each array is not significant.
 */
export const CAVEAT_MARKERS = Object.freeze({
  uncertainty: Object.freeze([
    'unverified', 'unconfirmed', 'alleged', 'allegedly', 'reportedly',
    'claimed', 'self-reported', 'preliminary', 'provisional', 'disputed',
    'anecdotal', 'unaudited', 'uncorroborated'
  ]),
  hedge: Object.freeze([
    'estimated', 'estimate', 'approximately', 'approx', 'roughly', 'about',
    'around', 'circa', '~', 'on the order of', 'order of magnitude', 'nearly',
    'almost'
  ]),
  scope: Object.freeze([
    'in this sample', 'among respondents', 'self-selected', 'non-random',
    'n=', 'single site', 'single-site', 'pilot', 'subset', 'of those surveyed',
    'in our sample', 'convenience sample'
  ]),
  condition: Object.freeze([
    'projected', 'forecast', 'forecasted', 'expected', 'target', 'goal',
    'anticipated', 'planned', 'on track to', 'assuming', 'if sustained',
    'all else equal'
  ]),
  temporal: Object.freeze([
    'as of', 'at the time', 'to date', 'year to date', 'ytd', 'so far',
    'currently', 'at present', 'previously', 'historically'
  ]),
  comparison_basis: Object.freeze([
    'compared with', 'compared to', 'relative to', 'versus', 'vs',
    'against a base of', 'on a base of', 'out of a total of', 'of the total',
    'not commensurable', 'different base', 'like for like', 'like-for-like'
  ]),
  other: Object.freeze([
    'may', 'might', 'could', 'appears to', 'seems to', 'suggests',
    'consistent with', 'indicative of', 'possibly', 'potentially'
  ])
});

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The hard veto table.
 *
 * `currency` / `percent` / `duration` are mutually exclusive: `$44M` is not
 * `44%` and neither is `44 days`, and no amount of lexical similarity should be
 * able to argue otherwise. That is why the veto is checked BEFORE scoring and
 * returns a hard zero rather than a penalty.
 *
 * `dimensionless`, `count`, `ratio` and `unknown` veto NOTHING, deliberately. A
 * bare `44` may legitimately be the restatement of `44%` with the unit dropped
 * — that is the `unit_drift`/`unit_dropped` subtype, which we must be able to
 * SEE — and `half` is a legitimate restatement of `50%`. Vetoing either would
 * make its own corruption class unreachable, which is the same mistake as
 * aligning on the number (contract.js decision 3).
 */
export const EXCLUSIVE_DIMENSIONS = Object.freeze(new Set(['currency', 'percent', 'duration']));

/** True when two dimensions may not describe the same quantity. */
export function dimensionsConflict(a, b) {
  if (!a || !b || a === b) return false;
  return EXCLUSIVE_DIMENSIONS.has(a) && EXCLUSIVE_DIMENSIONS.has(b);
}

/**
 * Rank used by `pickPrimary` to choose a sentence's main quantity.
 * Higher wins; ties break leftmost. `unknown` ranks last — it is the escape
 * hatch, never a preference.
 */
export const DIMENSION_RANK = Object.freeze({
  percent: 6, ratio: 5, currency: 4, duration: 3, count: 2, dimensionless: 1, unknown: 0
});

/* -------------------------------------------------------------------------- */
/* Surface vocabulary used by the quantity parser                             */
/* -------------------------------------------------------------------------- */

/** Skipped by `headNounAfter` on the way to the real head noun. */
export const HEAD_SKIP = Object.freeze(new Set([
  'of', 'the', 'a', 'an', 'all', 'its', 'our', 'their', 'these', 'those',
  'his', 'her', 'my', 'your', 'this', 'that', 'some', 'both', 'every', 'each',
  'total', 'about'
]));

/** Month names — a 4-digit number beside one of these is a date, not a claim. */
export const MONTHS = Object.freeze(new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct',
  'nov', 'dec'
]));

/** Prepositions that mark a following 4-digit number as a date, not a claim. */
export const DATE_PREPS = Object.freeze(new Set([
  'in', 'since', 'by', 'during', 'until', 'before', 'after', 'from', 'through'
]));

/** Words that make a following number an enumeration rather than a measurement. */
export const ENUM_MARKERS = Object.freeze(new Set([
  'figure', 'fig', 'table', 'section', 'step', 'phase', 'chapter', 'appendix',
  'item', 'note', 'footnote', 'page', 'line', 'version', 'v', 'no', 'ref',
  'part', 'stage', 'hop', 'tier', 'level', 'round'
]));

/** Currency symbols and codes recognised by the money parser. */
export const CURRENCY = Object.freeze(new Map(Object.entries({
  $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR',
  usd: 'USD', eur: 'EUR', gbp: 'GBP', inr: 'INR', jpy: 'JPY'
})));

/** Magnitude suffixes: `$44M` -> 44 * 1e6. */
export const MAGNITUDE = Object.freeze(new Map(Object.entries({
  k: 1e3, thousand: 1e3,
  m: 1e6, mn: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, tn: 1e12, trillion: 1e12
})));

/** Duration units, normalised to seconds so `90 minutes` and `1.5 hours` meet. */
export const DURATION_UNITS = Object.freeze(new Map(Object.entries({
  ms: 0.001, millisecond: 0.001, milliseconds: 0.001,
  sec: 1, secs: 1, second: 1, seconds: 1, s: 1,
  min: 60, mins: 60, minute: 60, minutes: 60,
  hr: 3600, hrs: 3600, hour: 3600, hours: 3600, h: 3600,
  day: 86400, days: 86400,
  week: 604800, weeks: 604800,
  month: 2629800, months: 2629800,
  quarter: 7889400, quarters: 7889400,
  year: 31557600, years: 31557600, yr: 31557600, yrs: 31557600
})));

/* -------------------------------------------------------------------------- */
/* Stemming                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Irregulars the suffix rules below would mangle. Small on purpose: every entry
 * is a word the ideation corpus actually uses.
 */
const IRREGULAR = Object.freeze(new Map(Object.entries({
  was: 'be', were: 'be', is: 'be', are: 'be', been: 'be', being: 'be',
  has: 'have', had: 'have', having: 'have',
  data: 'data', analysis: 'analysi', basis: 'basi', bases: 'basi',
  this: 'this', its: 'it', less: 'less', gas: 'gas', bus: 'bus',
  says: 'say', said: 'say'
})));

/**
 * A small S-stemmer: enough to make "dispatches"/"dispatch" and
 * "reported"/"report" meet, and deliberately no more.
 *
 * This is NOT Porter. A full stemmer conflates words a claim-checker needs kept
 * apart, and every conflation is a potential false match on stage. The rules
 * are ordered longest-suffix-first and each keeps a minimum stem length, so
 * short words are left alone.
 */
export function stem(word) {
  if (typeof word !== 'string' || word.length === 0) return '';
  let w = word.toLowerCase();

  // Keep the token, drop decoration. Hyphens and digits survive — they are the
  // most identifying things a token can carry (see score.js anchors).
  w = w.replace(/^[^a-z0-9~-]+/, '').replace(/[^a-z0-9%-]+$/, '');
  if (w.length === 0) return '';

  const irregular = IRREGULAR.get(w);
  if (irregular !== undefined) return irregular;

  // Anything with a digit in it is an identifier, not an English word.
  if (/\d/.test(w)) return w;

  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ment')) return w.slice(0, -4);
  if (w.length > 5 && w.endsWith('tion')) return `${w.slice(0, -4)}t`;
  if (w.length > 5 && w.endsWith('sion')) return `${w.slice(0, -4)}s`;
  if (w.length > 4 && w.endsWith('ness')) return w.slice(0, -4);
  if (w.length > 4 && w.endsWith('edly')) return w.slice(0, -4);
  if (w.length > 4 && w.endsWith('ing')) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith('ly')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('ed')) return undouble(w.slice(0, -2));
  if (w.length > 4 && (w.endsWith('ches') || w.endsWith('shes') || w.endsWith('sses') || w.endsWith('xes'))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('es')) return w.slice(0, -1);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** `dropp` -> `drop`. Undo the consonant doubling that -ed/-ing introduce. */
function undouble(w) {
  if (w.length > 3 && /([bdfglmnprt])\1$/.test(w)) return w.slice(0, -1);
  return w;
}
