/**
 * text.js — document primitives: sentence and token splitting with exact
 * offsets, and the O(n) position index. Spans are JS string indices into the
 * UTF-8-decoded file, never byte offsets (contract.js, decision 2).
 *
 * Owns: split, tokenise, offsets. Depends on: lexicon.
 *
 * ---------------------------------------------------------------------------
 * ON THE TWO UNITS. contract.js decision 2 is the authority: every `span` this
 * module emits is a pair of JavaScript string indices — UTF-16 code units, what
 * `String.prototype.slice` uses — into the file as read with
 * `readFileSync(path, 'utf8')`. `sha256` is over the file's BYTES. Different
 * units, deliberately, each stated.
 *
 * `buildByteIndex` is provided for the one caller that genuinely needs the
 * other unit (anything reporting a byte offset into the raw file). It is NOT
 * used to build spans, and BUILD-PLAN.md's "byte index" line for this module is
 * superseded by contract.js decision 2. It exists here, rather than inline at
 * the call site, because the obvious implementation —
 * `Buffer.byteLength(str.slice(0, i))` inside a loop — is O(n^2) and silently
 * turns a 200 KB corpus into a stall. This one is a single pass.
 */

import { STOPWORDS, stem } from './lexicon.js';

export { stem };

/* -------------------------------------------------------------------------- */
/* Byte index                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Map every JS string index to its UTF-8 byte offset, in ONE pass.
 *
 * Returns a Uint32Array of length `str.length + 1`, so `idx[str.length]` is the
 * total byte length and a half-open span [a, b) maps to [idx[a], idx[b]).
 *
 * A surrogate pair occupies two string indices but one character and four
 * bytes; both of its indices map to the byte offset where that character
 * starts, because there is no byte boundary in the middle of it to point at.
 */
export function buildByteIndex(str) {
  const idx = new Uint32Array(str.length + 1);
  let bytes = 0;
  let i = 0;
  while (i < str.length) {
    const c = str.charCodeAt(i);
    idx[i] = bytes;
    if (c < 0x80) {
      bytes += 1;
      i += 1;
    } else if (c < 0x800) {
      bytes += 2;
      i += 1;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        idx[i + 1] = bytes; // mid-character: no byte boundary exists here
        bytes += 4;
        i += 2;
      } else {
        bytes += 3; // lone high surrogate; encoders emit the replacement char
        i += 1;
      }
    } else {
      bytes += 3;
      i += 1;
    }
  }
  idx[str.length] = bytes;
  return idx;
}

/* -------------------------------------------------------------------------- */
/* Paragraphs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Split on blank lines. Returns `{text, span}` where
 * `text === source.slice(span.start, span.end)` exactly — contract.js's
 * validateParsedCore checks that equality and throws if we trim without moving
 * the span with it.
 */
export function splitParagraphs(source) {
  const out = [];
  const re = /\n[ \t]*\n/g;
  let start = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    pushTrimmed(out, source, start, m.index);
    start = m.index + m[0].length;
  }
  pushTrimmed(out, source, start, source.length);
  return out;
}

/** Push `source[from, to)` with surrounding whitespace removed from BOTH the
 *  text and the span, so the two never disagree. Empty slices are dropped. */
function pushTrimmed(out, source, from, to) {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(source[a])) a += 1;
  while (b > a && /\s/.test(source[b - 1])) b -= 1;
  if (b > a) out.push({ text: source.slice(a, b), span: { start: a, end: b } });
}

/* -------------------------------------------------------------------------- */
/* Sentences                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Tokens that end in a period WITHOUT ending a sentence.
 *
 * The guard matters more than it looks: the ideation corpus is full of "Fig. 3",
 * "e.g.", "approx." and "No. 2", and a split in the middle of one of those
 * hands diff.js half a claim and half a unit. Splitting "0.79" would be worse
 * still — it would destroy the exact number the demo turns on.
 */
const ABBREVIATIONS = Object.freeze(new Set([
  'dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'st', 'mt',
  'e.g', 'i.e', 'eg', 'ie', 'etc', 'vs', 'cf', 'al', 'ca', 'approx',
  'fig', 'figs', 'tbl', 'no', 'nos', 'vol', 'ed', 'eds', 'pp', 'p',
  'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'min', 'max', 'avg',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec'
]));

/**
 * Split `source[offset ...]` into sentences, returning absolute spans.
 *
 * `text` is the exact slice of the ORIGINAL source, so a caller can hand it
 * straight to contract.js. `offset` is where `body` starts in that source.
 */
export function splitSentences(body, offset = 0) {
  const out = [];
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '\n') continue;

    if (ch === '\n') {
      // A hard line break ends a sentence only when the next line starts a new
      // one — markdown bullets and headings, which the briefs are full of.
      if (!startsNewBlock(body, i + 1)) continue;
    } else {
      let j = i;
      while (j + 1 < body.length && '.!?"”’)]'.includes(body[j + 1])) j += 1;
      if (!isSentenceEnd(body, i, j)) continue;
      i = j;
    }

    pushTrimmedAbs(out, body, start, i + 1, offset);
    start = i + 1;
  }
  pushTrimmedAbs(out, body, start, body.length, offset);
  return out;
}

function pushTrimmedAbs(out, body, from, to, offset) {
  let a = from;
  let b = to;
  while (a < b && /\s/.test(body[a])) a += 1;
  while (b > a && /\s/.test(body[b - 1])) b -= 1;
  if (b > a) out.push({ text: body.slice(a, b), span: { start: offset + a, end: offset + b } });
}

/** True when the line beginning at `k` opens a new block (bullet or heading). */
function startsNewBlock(body, k) {
  let i = k;
  while (i < body.length && (body[i] === ' ' || body[i] === '\t')) i += 1;
  if (i >= body.length) return true;
  return /[-*+#>|]/.test(body[i]) || /^\d+[.)]\s/.test(body.slice(i, i + 4));
}

/**
 * Is the terminator at `i` (run ending at `j`) actually the end of a sentence?
 */
function isSentenceEnd(body, i, j) {
  if (body[i] !== '.') return true; // ! and ? are unambiguous here

  // A decimal point: 0.79, 2.5x. Never a sentence end.
  if (i > 0 && /\d/.test(body[i - 1]) && i + 1 < body.length && /\d/.test(body[i + 1])) return false;

  // Nothing after it — end of input is an end of sentence.
  let k = j + 1;
  while (k < body.length && (body[k] === ' ' || body[k] === '\t')) k += 1;
  if (k >= body.length) return true;

  // A known abbreviation, or a single-letter initial ("K. Smith").
  let a = i;
  while (a > 0 && /[A-Za-z.]/.test(body[a - 1])) a -= 1;
  const word = body.slice(a, i).toLowerCase();
  if (word.length === 1 && /[a-z]/.test(word)) return false;
  if (ABBREVIATIONS.has(word)) return false;

  // A real sentence resumes with a capital, a digit, or a quote/bracket.
  return /[A-Z0-9“"'(\[]/.test(body[k]) || body[k] === '\n';
}

/* -------------------------------------------------------------------------- */
/* Tokens                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A token starts with a letter, a digit, a currency symbol or `~`, and may
 * carry `%`, `.`, `,`, `/`, `-` and `_` inside it. Keeping those INSIDE the
 * token is what lets `44%`, `2/17`, `$44M`, `n=252` and `self-reported` survive
 * to the quantity parser and the anchor set as single identifying units.
 */
const TOKEN_RE = /[\p{L}\p{N}$€£¥₹~][\p{L}\p{N}%$€£¥₹~.,/=_-]*/gu;
const TRAILING_JUNK = /[.,/=_'’-]+$/;

/**
 * @typedef {Object} Token
 * @property {string} raw     Exact source text.
 * @property {string} lower   Lowercased.
 * @property {string} stem    lexicon.js stem ('' if the token stems to nothing).
 * @property {{start,end}} span Absolute JS string indices.
 * @property {number} index   0-based position within this sentence.
 * @property {boolean} first  True for the sentence-initial token.
 * @property {boolean} stop   True when `lower` is a stopword.
 * @property {boolean} capitalised True when the raw token starts upper-case.
 * @property {boolean} hasDigit  True when the token contains a digit.
 */

/** Tokenise `body`, emitting absolute spans offset by `offset`. */
export function tokenize(body, offset = 0) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(body)) !== null) {
    let raw = m[0];
    const start = offset + m.index;
    const trimmed = raw.replace(TRAILING_JUNK, '');
    if (trimmed.length === 0) continue;
    raw = trimmed;
    const lower = raw.toLowerCase();
    out.push({
      raw,
      lower,
      stem: stem(raw),
      span: { start, end: start + raw.length },
      index: out.length,
      first: out.length === 0,
      stop: STOPWORDS.has(lower),
      capitalised: /^[A-Z]/.test(raw),
      hasDigit: /\d/.test(raw)
    });
  }
  return out;
}

/**
 * The content stems of a token list: stopwords dropped, empty stems dropped,
 * and anything that is purely a number dropped.
 *
 * Numbers are excluded ON PURPOSE. They belong to the NUM channel, and letting
 * them into the lexical bag would quietly reintroduce "align on the number"
 * through the side door — the exact failure contract.js decision 3 forbids. A
 * token like `n=252` or `2019-Q3` keeps its digits and stays, because it is an
 * identifier rather than a measurement.
 */
export function contentStems(tokens, excludeSpans = []) {
  const out = [];
  for (const t of tokens) {
    if (t.stop || t.stem === '') continue;
    if (/^[\d.,%$€£¥₹~/-]+$/.test(t.raw)) continue;
    if (excludeSpans.some((s) => t.span.start < s.end && t.span.end > s.start)) continue;
    out.push(t.stem);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Similarity primitives                                                      */
/* -------------------------------------------------------------------------- */

/** Character trigrams of a string, padded so short words still produce some. */
export function trigrams(s) {
  const w = `  ${String(s ?? '').toLowerCase()} `;
  const out = new Set();
  for (let i = 0; i + 3 <= w.length; i += 1) out.add(w.slice(i, i + 3));
  return out;
}

/**
 * Sørensen–Dice over two sets: 2|A ∩ B| / (|A| + |B|).
 *
 * Two empty sets score 0, not 1. "Neither side has any evidence" is not
 * agreement, and treating it as agreement is how a checker starts matching
 * everything to everything.
 */
export function dice(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  const [small, large] = A.size <= B.size ? [A, B] : [B, A];
  for (const x of small) if (large.has(x)) shared += 1;
  return (2 * shared) / (A.size + B.size);
}
