/**
 * BATON — packages/align/contract.js
 *
 * ============================================================================
 * THIS FILE IS FROZEN. Every other module in packages/align is written against
 * it, and packages/sign signs objects built by it. Nobody changes a field name
 * or an enum member without Kevin.
 * ============================================================================
 *
 * The job of this file is to make BATON's honesty mechanically enforceable
 * rather than a thing we remembered to do — the same discipline as HOOKPRINT's
 * `makeFinding` (extension/src/detectors/util.js) and CONTRACT.md rule 1.
 *
 * A Delta cannot be constructed with a class outside the frozen four, a
 * severity outside the frozen three, or without an evidence pointer at both
 * ends. A Claim cannot be constructed with a quote whose length disagrees with
 * its span. An unaligned candidate cannot be recorded without a reason from the
 * frozen list. Those constructors throw, and the tests must see it.
 *
 * ---------------------------------------------------------------------------
 * SIX DECISIONS THAT ARE LOAD-BEARING. Read these before writing a module.
 * ---------------------------------------------------------------------------
 *
 * 1. ONE PARSER. Origins and candidates are both produced by extract.js, and
 *    both carry the identical Parsed core (text, span, ordinal, quantity,
 *    numerator, denominator, unit, caveats). makeClaim and makeCandidate share
 *    `validateParsedCore` for exactly this reason. If the two sides are ever
 *    parsed by different code, diff.js stops comparing a claim to its
 *    restatement and starts comparing two parsers' opinions — every difference
 *    in tokenisation becomes a phantom delta on stage.
 *
 * 2. SPANS ARE JAVASCRIPT STRING INDICES, NOT BYTE OFFSETS.
 *    `{start, end}` are half-open indices into the file content as read with
 *    `readFileSync(path, 'utf8')` — i.e. UTF-16 code units, the unit
 *    `String.prototype.slice` uses. They are NOT UTF-8 byte offsets. The
 *    ideation corpus contains em-dashes, arrows and `₹`; mixing the two units
 *    puts a judge's click on the wrong sentence. `sha256` is over the file
 *    BYTES; the span is over the decoded STRING. Different units, deliberately,
 *    each stated. (BUILD-PLAN.md says "byte index" for text.js — overridden
 *    here, with this reason.)
 *
 * 3. DO NOT ALIGN ON THE NUMBER, AND DO NOT LET AN AMBIGUOUS MATCH SPEAK.
 *    Value drift is a corruption class, so an aligner requiring numeric
 *    agreement can never reach its own headline finding. Alignment therefore
 *    admits `decision: 'ambiguous'`, and **diff.js must emit no Delta from an
 *    ambiguous alignment.** A wrong match producing a confident `value_drift`
 *    is worse than an honest `unaligned` row.
 *
 * 4. THE RECEIPT IS PART OF THE PRODUCT. `unaligned[]` and `dropped_claims[]`
 *    are not failure logs — they are what we show when a judge asks how we know
 *    we are not flagging everything. Both reasons come from frozen lists, so
 *    the receipt is countable. Never fabricate a match to fill the table.
 *
 * 5. NO CLOCK, NO RANDOMNESS, NO NETWORK. A Report contains no timestamp and no
 *    generated id. Two runs over the same bytes produce byte-identical JSON.
 *    That is the pitch line ("you can run our checker with the network off")
 *    and verification test #16, and a timestamp would quietly cost us both.
 *
 * 6. CONSTRUCTED OBJECTS ARE ALREADY CANONICAL. Every constructor below builds
 *    its object with a fixed literal key order, so `JSON.stringify(claim)` is a
 *    canonical encoding with no sorting step. packages/sign signs that string
 *    directly.
 */

export const CONTRACT_VERSION = '1.0.0';

/* -------------------------------------------------------------------------- */
/* Frozen vocabularies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The four corruption classes. This list is the pitch. It does not grow during
 * the build — BUILD-PLAN.md "OUT: coverage beyond the four corruption classes".
 * Array order is also the canonical sort order of deltas within a claim.
 */
export const DELTA_CLASSES = Object.freeze([
  'value_drift',
  'unit_drift',
  'denominator_loss',
  'caveat_loss'
]);

/** How loud a delta is. Frozen. */
export const SEVERITIES = Object.freeze(['fail', 'warn', 'note']);

/** An alignment either speaks or admits it cannot. Frozen. */
export const DECISIONS = Object.freeze(['matched', 'ambiguous']);

/**
 * What kind of thing the number is. `unknown` is the honest escape hatch —
 * quantity.js returns it rather than guessing, and diff.js must not raise
 * `unit_drift` when either side is `unknown`.
 */
export const DIMENSIONS = Object.freeze([
  'percent',
  'count',
  'currency',
  'duration',
  'ratio',
  'dimensionless',
  'unknown'
]);

/**
 * Caveat kinds. `comparison_basis` is the one the demo turns on: the hop-3
 * sentence compares a bare rate against published figures, and the clause
 * saying the bases are not commensurable is what went missing.
 */
export const CAVEAT_KINDS = Object.freeze([
  'hedge',
  'scope',
  'condition',
  'temporal',
  'uncertainty',
  'comparison_basis',
  'other'
]);

/**
 * How a magnitude's denominator (or numerator) was obtained.
 *
 * This is what keeps verification test #10 honest — "denominator never existed
 * → zero denominator_loss findings". A denominator that was only ever
 * `inherited` from an adjacent sentence is not the same evidence as one stated
 * `explicit`ly, and diff.js is entitled to weigh them differently.
 */
export const PROVENANCE = Object.freeze(['explicit', 'derived', 'inherited']);

/** Why a candidate carries no alignment. Frozen — this table gets rendered. */
export const UNALIGNED_REASONS = Object.freeze([
  'below_floor', // best score under the accept threshold
  'ambiguous', // two claims equally plausible; we decline to guess
  'no_quantity', // no parseable quantity, so nothing checkable (fallback C)
  'claim_exhausted', // its best claim is already held by a stronger candidate
  'out_of_order' // rejected by the monotonic constraint (fallback B)
]);

/** Why an origin claim never found a restatement. Frozen. */
export const DROPPED_CLAIM_REASONS = Object.freeze([
  'no_candidate', // nothing downstream scored above the floor
  'ambiguous_only', // everything above the floor was ambiguous
  'hop_absent' // the downstream document does not exist
]);

/**
 * Known delta subtypes, per class.
 *
 * `class` and `severity` are frozen — they are the vocabulary on the slide and
 * changing one is expensive. `subtype` is deliberately NOT frozen: it is cheap
 * to change, diff.js is being written against this file right now, and blocking
 * a subtype nobody anticipated would be the contract getting in the way of the
 * work. A subtype must merely be lower_snake_case. This table is the starting
 * vocabulary, not a fence.
 */
export const KNOWN_SUBTYPES = Object.freeze({
  value_drift: Object.freeze([
    'outside_band', // restated value falls outside the origin's precision band
    'rounded_up', // moved away from zero within one order of magnitude
    'rounded_down',
    'order_of_magnitude', // 0.79 -> 79
    'precision_invented' // "about 40" restated as "41.3"
  ]),
  unit_drift: Object.freeze([
    'dimension_changed', // percent -> count
    'unit_substituted', // "dispatches" -> "records"
    'unit_dropped' // "44 minutes" -> "44"
  ]),
  denominator_loss: Object.freeze([
    'base_dropped', // "2 of 252" -> "0.79%"
    'base_changed', // 252 -> 263
    'base_substituted', // same numerator quoted against a different base
    'rate_compared_bare' // bare rate compared against a figure with another base
  ]),
  caveat_loss: Object.freeze([
    'hedge_dropped',
    'scope_dropped',
    'condition_dropped',
    'uncertainty_dropped',
    'comparison_basis_dropped'
  ])
});

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

const SUBTYPE_RE = /^[a-z][a-z0-9_]*$/;
const CLAIM_ID_RE = /^c_\d{3,}$/;
const CID_RE = /^h(\d+)_\d{3,}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(where, msg) {
  throw new Error(`${where}: ${msg}`);
}

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function isNonEmptyString(x) {
  return typeof x === 'string' && x.length > 0;
}

function isPlainObject(x) {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x);
}

/**
 * A half-open range of JS string indices into a source document.
 * Accepts the tolerant alias `[start, end]` — a near-miss on shape should not
 * silently produce zero findings (schema.js discipline).
 */
export function makeSpan(raw, where = 'makeSpan') {
  let start;
  let end;
  if (Array.isArray(raw) && raw.length === 2) {
    [start, end] = raw;
  } else if (isPlainObject(raw)) {
    ({ start, end } = raw);
  } else {
    fail(where, 'span must be {start, end} or [start, end]');
  }
  if (!Number.isInteger(start) || start < 0) fail(where, `span.start must be a non-negative integer, got ${start}`);
  if (!Number.isInteger(end) || end <= start) fail(where, `span.end must be an integer > start, got ${end} (start ${start})`);
  return { start, end };
}

export function isSpan(x) {
  return (
    isPlainObject(x) &&
    Number.isInteger(x.start) &&
    x.start >= 0 &&
    Number.isInteger(x.end) &&
    x.end > x.start
  );
}

/** Length of the text a span covers. Used to check quote/span agreement. */
export function spanLength(span) {
  return span.end - span.start;
}

/* -------------------------------------------------------------------------- */
/* The Parsed core — shared by Claim and Candidate                            */
/* -------------------------------------------------------------------------- */

/**
 * A number as it appears in prose.
 *
 * `band` is the tolerance interval the ORIGIN's own precision implies, and it
 * is where the vagueness policy lives — so diff.js asks one uniform question
 * ("is the restated value inside the origin's band?") and never has to
 * re-derive what "about 40%" was willing to tolerate. An exact token gets
 * `band: [value, value]`. Either bound may be `null`, meaning unbounded on that
 * side ("more than 200" → `[200, null]`); diff.js treats null as unbounded
 * rather than inventing a ceiling.
 *
 * `value` may be null ONLY for a vague quantity with no number at all ("most",
 * "the majority"), which then must carry at least one finite band bound.
 * Writing a number there would be a fabrication, and we do not fabricate.
 *
 * `precision` is the count of digits after the decimal point in `raw` — a
 * mechanical fact about the token, not a judgement.
 */
export function makeQuantity(input, where = 'makeQuantity') {
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { raw, value, dimension, vague, band, precision, span } = input;
  if (!isNonEmptyString(raw)) fail(where, 'raw must be the non-empty source token');
  if (!DIMENSIONS.includes(dimension)) fail(where, `dimension "${dimension}" is not in the frozen list`);
  if (typeof vague !== 'boolean') fail(where, 'vague must be a boolean');
  if (!Number.isInteger(precision) || precision < 0) fail(where, 'precision must be a non-negative integer (decimal places in raw)');
  if (value !== null && !isFiniteNumber(value)) fail(where, 'value must be a finite number, or null for a vague quantity with no number');

  if (!Array.isArray(band) || band.length !== 2) fail(where, 'band must be [lo, hi]');
  const [lo, hi] = band;
  if (lo !== null && !isFiniteNumber(lo)) fail(where, 'band[0] must be a finite number or null (unbounded below)');
  if (hi !== null && !isFiniteNumber(hi)) fail(where, 'band[1] must be a finite number or null (unbounded above)');
  if (lo !== null && hi !== null && lo > hi) fail(where, `band is inverted: [${lo}, ${hi}]`);

  if (value === null) {
    if (!vague) fail(where, 'a null value is only legal on a vague quantity');
    if (lo === null && hi === null) fail(where, 'a null value needs at least one finite band bound, or it says nothing');
  } else {
    if (lo !== null && value < lo) fail(where, `value ${value} is below its own band lower bound ${lo}`);
    if (hi !== null && value > hi) fail(where, `value ${value} is above its own band upper bound ${hi}`);
  }

  return {
    raw,
    value: value ?? null,
    dimension,
    vague,
    band: [lo ?? null, hi ?? null],
    precision,
    span: makeSpan(span, where)
  };
}

/**
 * One side of a ratio — "2" or "252" in "2 of 252 dispatches".
 *
 * Numerator and denominator share ONE shape and ONE constructor. The draft
 * carried `unitStem`/`provenance` on the denominator only; they are here on
 * both because the two sides come out of the same parser and because the
 * numerator's unit is genuinely elided-and-inherited in the corpus ("2 of 252
 * dispatches"). One shape used twice is cheaper to hold than two near-identical
 * shapes. `provenance` defaults to 'explicit' and `unitStem` to null so a
 * draft-shaped call still constructs.
 */
export function makeMagnitude(input, where = 'makeMagnitude') {
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { value, unit, unitStem, provenance = 'explicit', span } = input;
  if (!isFiniteNumber(value)) fail(where, 'value must be a finite number');
  if (unit !== null && unit !== undefined && typeof unit !== 'string') fail(where, 'unit must be a string or null');
  if (unitStem !== null && unitStem !== undefined && typeof unitStem !== 'string') fail(where, 'unitStem must be a string or null');
  if (!PROVENANCE.includes(provenance)) fail(where, `provenance "${provenance}" is not in the frozen list`);
  return {
    value,
    unit: unit ?? null,
    unitStem: unitStem ?? null,
    provenance,
    span: makeSpan(span, where)
  };
}

/** The unit attached to the quantity itself. `stem` is lexicon.js's output. */
export function makeUnitRef(input, where = 'makeUnitRef') {
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { term, stem, span } = input;
  if (!isNonEmptyString(term)) fail(where, 'term must be a non-empty string');
  if (!isNonEmptyString(stem)) fail(where, 'stem must be a non-empty string (lexicon.js normalises it)');
  return { term, stem, span: makeSpan(span, where) };
}

/** A qualifier whose disappearance is a corruption. */
export function makeCaveat(input, where = 'makeCaveat') {
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { kind, term, span } = input;
  if (!CAVEAT_KINDS.includes(kind)) fail(where, `kind "${kind}" is not in the frozen list`);
  if (!isNonEmptyString(term)) fail(where, 'term must be the non-empty source text of the caveat');
  return { kind, term, span: makeSpan(span, where) };
}

/**
 * Validate and normalise the core that a Claim and a Candidate share.
 *
 * This function is decision 1 made mechanical: there is exactly one definition
 * of what a parsed sentence looks like, and both sides of every diff went
 * through it.
 *
 * `requireQuantity` is the one asymmetry, and it is deliberate:
 *   - a CLAIM must carry a quantity — a claim is a quantified assertion, and
 *     that is BATON's stated scope;
 *   - a CANDIDATE may carry `quantity: null` — candidates are harvested from
 *     every sentence before scoring, and a null-quantity candidate is exactly
 *     what earns the `no_quantity` unaligned receipt (fallback C's honesty
 *     floor, mechanised).
 */
function validateParsedCore(input, where, { requireQuantity }) {
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { text, span, ordinal, quantity, numerator, denominator, unit, caveats } = input;

  if (!isNonEmptyString(text)) fail(where, 'text must be a non-empty string');
  const s = makeSpan(span, where);
  if (text.length !== spanLength(s)) {
    fail(
      where,
      `text length ${text.length} disagrees with span length ${spanLength(s)} — ` +
        'text must be exactly source.slice(span.start, span.end). ' +
        'A normalised string with an unnormalised span puts the judge\'s click on the wrong sentence. ' +
        'Keep the normalised form out of the contract and recompute it from lexicon.js when you need it.'
    );
  }
  if (!Number.isInteger(ordinal) || ordinal < 0) fail(where, 'ordinal must be a non-negative integer (document order, 0-based)');

  let q = null;
  if (quantity === null || quantity === undefined) {
    if (requireQuantity) fail(where, 'quantity is required — a Claim is a quantified assertion (see validateParsedCore)');
  } else {
    q = makeQuantity(quantity, `${where}.quantity`);
  }

  const num = numerator === null || numerator === undefined ? null : makeMagnitude(numerator, `${where}.numerator`);
  const den = denominator === null || denominator === undefined ? null : makeMagnitude(denominator, `${where}.denominator`);
  const u = unit === null || unit === undefined ? null : makeUnitRef(unit, `${where}.unit`);

  if (!Array.isArray(caveats)) fail(where, 'caveats must be an array (empty is fine, absent is not)');
  const cav = caveats.map((c, i) => makeCaveat(c, `${where}.caveats[${i}]`));

  return { text, span: s, ordinal, quantity: q, numerator: num, denominator: den, unit: u, caveats: cav };
}

/**
 * The shared output of extract.js, before mint.js promotes it to a Claim or the
 * candidate path wraps it as a Candidate. Exported so extract.js has one
 * constructor and neither wrapper can drift from it.
 */
export function makeParsed(input) {
  return validateParsedCore(input, 'makeParsed', { requireQuantity: false });
}

/* -------------------------------------------------------------------------- */
/* Claim                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a claim came from, exactly. This is the object packages/sign signs, and
 * it is CONTRACT.md rule 1 carried into BATON: a claim we cannot point at is an
 * accusation, and we do not make accusations.
 *
 * `sha256` is over the source file's BYTES; `span` indexes the decoded STRING.
 * `quote` is exactly `source.slice(span.start, span.end)` — enforced.
 */
export function makeEvidence(input, where = 'makeEvidence') {
  if (!isPlainObject(input)) fail(where, 'expected an object — a claim without evidence is an accusation (CONTRACT.md rule 1)');
  const { source, sha256, span, quote } = input;
  if (!isNonEmptyString(source)) fail(where, 'source must be the file path the claim was read from');
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) fail(where, 'sha256 must be 64 lowercase hex chars of the source file bytes');
  const s = makeSpan(span, where);
  if (!isNonEmptyString(quote)) fail(where, 'quote must be non-empty');
  if (quote.length !== spanLength(s)) {
    fail(where, `quote length ${quote.length} disagrees with span length ${spanLength(s)} — quote must be source.slice(span.start, span.end)`);
  }
  return { source, sha256, span: s, quote };
}

/**
 * An origin claim: a quantified assertion minted from one hop's document, with
 * an id that is NEVER carried downstream. Re-identifying it after a rewrite is
 * the entire product — see BUILD-PLAN.md, version (ii).
 */
export function makeClaim(input) {
  const where = 'makeClaim';
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { id, hop, evidence } = input;

  if (typeof id !== 'string' || !CLAIM_ID_RE.test(id)) fail(where, `id must match c_NNN, got ${JSON.stringify(id)}`);
  if (!Number.isInteger(hop) || hop < 1) fail(where, 'hop must be an integer >= 1 (the demo is 1-based: researcher=1, summariser=2, writer=3)');

  const core = validateParsedCore(input, where, { requireQuantity: true });
  const ev = makeEvidence(evidence, `${where}.evidence`);

  return {
    id,
    hop,
    text: core.text,
    quantity: core.quantity,
    numerator: core.numerator,
    denominator: core.denominator,
    unit: core.unit,
    caveats: core.caveats,
    evidence: ev,
    ordinal: core.ordinal
  };
}

/* -------------------------------------------------------------------------- */
/* Candidate                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A sentence in a downstream document that MIGHT be a restatement of some
 * claim. It carries no claim id, because the agent that wrote it did not have
 * one.
 *
 * `neighbours` is not decoration. Verification test #12 — "a hoisted caveat is
 * not reported as stripped" — is the likeliest false positive in the whole
 * system, and the adjacent sentences are how diff.js sees that the qualifier
 * moved rather than vanished. Either side may be null at a document boundary.
 */
export function makeCandidate(input) {
  const where = 'makeCandidate';
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { cid, hop, file, sha256, neighbours } = input;

  const m = typeof cid === 'string' ? CID_RE.exec(cid) : null;
  if (!m) fail(where, `cid must match hN_NNN (e.g. h2_014), got ${JSON.stringify(cid)}`);
  if (!Number.isInteger(hop) || hop < 1) fail(where, 'hop must be an integer >= 1');
  if (Number(m[1]) !== hop) fail(where, `cid "${cid}" says hop ${m[1]} but hop is ${hop}`);
  if (!isNonEmptyString(file)) fail(where, 'file must be the path the candidate was read from');
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) fail(where, 'sha256 must be 64 lowercase hex chars of the source file bytes');

  const core = validateParsedCore(input, where, { requireQuantity: false });

  if (!isPlainObject(neighbours)) fail(where, 'neighbours must be {prevSpan, nextSpan}, either of which may be null');
  const prevSpan = neighbours.prevSpan == null ? null : makeSpan(neighbours.prevSpan, `${where}.neighbours.prevSpan`);
  const nextSpan = neighbours.nextSpan == null ? null : makeSpan(neighbours.nextSpan, `${where}.neighbours.nextSpan`);

  return {
    cid,
    hop,
    file,
    sha256,
    span: core.span,
    text: core.text,
    quantity: core.quantity,
    numerator: core.numerator,
    denominator: core.denominator,
    unit: core.unit,
    caveats: core.caveats,
    neighbours: { prevSpan, nextSpan },
    ordinal: core.ordinal
  };
}

/* -------------------------------------------------------------------------- */
/* Alignment                                                                  */
/* -------------------------------------------------------------------------- */

function unitScore(x, field, where) {
  if (!isFiniteNumber(x) || x < 0 || x > 1) fail(where, `${field} must be a number in [0, 1], got ${x}`);
  return x;
}

/**
 * One candidate re-identified against one origin claim.
 *
 * `channels` are the three independent signals score.js combines — NUM
 * (numeric compatibility, NOT numeric equality), LEX (lexical overlap of the
 * surviving content words), POS (positional/ordinal agreement). They are kept
 * separate in the report so a judge can see WHY a paraphrase was re-identified,
 * and so the 2:30 checkpoint can be called on a channel rather than a hunch.
 *
 * `decision: 'ambiguous'` means the runner-up was too close to call. Such a row
 * still appears here — the receipt discipline — but diff.js MUST NOT emit a
 * Delta from it. See decision 3 in the header.
 *
 * `hop` is carried explicitly (it is not derivable from a Report alone, because
 * a Report holds no candidate table) — the UI's red edge and the demo's "names
 * the exact hop" both need it.
 */
export function makeAlignment(input) {
  const where = 'makeAlignment';
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { claimId, cid, hop, score, margin, channels, decision, runnerUp, supporting } = input;
  if (typeof claimId !== 'string' || !CLAIM_ID_RE.test(claimId)) fail(where, `claimId must match c_NNN, got ${JSON.stringify(claimId)}`);
  const m = typeof cid === 'string' ? CID_RE.exec(cid) : null;
  if (!m) fail(where, `cid must match hN_NNN, got ${JSON.stringify(cid)}`);
  if (!Number.isInteger(hop) || hop < 1) fail(where, 'hop must be an integer >= 1');
  if (Number(m[1]) !== hop) fail(where, `cid "${cid}" says hop ${m[1]} but hop is ${hop}`);

  unitScore(score, 'score', where);
  if (!isFiniteNumber(margin) || margin < 0) fail(where, `margin must be a non-negative number (score minus runner-up), got ${margin}`);
  if (!DECISIONS.includes(decision)) fail(where, `decision "${decision}" is not in the frozen list`);

  if (!isPlainObject(channels)) fail(where, 'channels must be {NUM, LEX, POS}');
  for (const k of ['NUM', 'LEX', 'POS']) {
    if (!(k in channels)) fail(where, `channels.${k} is missing`);
    unitScore(channels[k], `channels.${k}`, where);
  }

  let ru = null;
  if (runnerUp !== null && runnerUp !== undefined) {
    if (!isPlainObject(runnerUp)) fail(where, 'runnerUp must be {claimId, score} or null');
    if (typeof runnerUp.claimId !== 'string' || !CLAIM_ID_RE.test(runnerUp.claimId)) fail(where, 'runnerUp.claimId must match c_NNN');
    unitScore(runnerUp.score, 'runnerUp.score', where);
    if (runnerUp.score > score) fail(where, `runnerUp.score ${runnerUp.score} exceeds score ${score} — the runner-up is not the runner-up`);
    ru = { claimId: runnerUp.claimId, score: runnerUp.score };
  }

  const sup = supporting ?? [];
  if (!Array.isArray(sup)) fail(where, 'supporting must be an array of cids (empty is fine)');
  for (const s of sup) {
    if (typeof s !== 'string' || !CID_RE.test(s)) fail(where, `supporting cid ${JSON.stringify(s)} must match hN_NNN`);
  }

  return {
    claimId,
    cid,
    hop,
    score,
    margin,
    channels: { NUM: channels.NUM, LEX: channels.LEX, POS: channels.POS },
    decision,
    runnerUp: ru,
    supporting: [...sup]
  };
}

/* -------------------------------------------------------------------------- */
/* Delta                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Turn a Claim or a Candidate into a clickable pointer. Both shapes are
 * accepted so diff.js never has to remember which one it is holding.
 */
export function pointerOf(x, where = 'pointerOf') {
  if (!isPlainObject(x)) fail(where, 'expected a Claim or a Candidate');
  if (isPlainObject(x.evidence)) {
    const e = x.evidence;
    return { file: e.source, sha256: e.sha256, span: makeSpan(e.span, where), quote: e.quote };
  }
  if (isNonEmptyString(x.file)) {
    return { file: x.file, sha256: x.sha256, span: makeSpan(x.span, where), quote: x.text };
  }
  fail(where, 'object is neither a Claim (has .evidence) nor a Candidate (has .file)');
  return null; // unreachable; keeps the return type honest for callers
}

function validatePointer(p, label, where) {
  if (!isPlainObject(p)) fail(where, `${label} must be {file, sha256, span, quote}`);
  if (!isNonEmptyString(p.file)) fail(where, `${label}.file must be a non-empty string`);
  if (typeof p.sha256 !== 'string' || !SHA256_RE.test(p.sha256)) fail(where, `${label}.sha256 must be 64 lowercase hex chars`);
  const s = makeSpan(p.span, `${where}.${label}`);
  if (!isNonEmptyString(p.quote)) fail(where, `${label}.quote must be non-empty`);
  return { file: p.file, sha256: p.sha256, span: s, quote: p.quote };
}

/**
 * One corruption, located at both ends.
 *
 * `evidence` is required. A delta that cannot show the judge the origin
 * sentence AND the restatement is an accusation, and the receipt discipline we
 * inherited from CONTRACT.md rule 1 forbids it. It is free to satisfy: pass
 * `claim` and `candidate` instead and it is derived for you.
 *
 * `consequential` and `consistentDownstream` are omitted entirely when not
 * applicable — never present-and-undefined. Same rule as CONTRACT.md's
 * "Absent when `supported` is `false`".
 *   - consequential: the loss changes a conclusion someone would act on — the
 *     demo's case, where a bare rate is then compared against figures on
 *     another base.
 *   - consistentDownstream: the corrupted figure is reused coherently in later
 *     hops. That makes it harder to spot, not less serious.
 */
export function makeDelta(input) {
  const where = 'makeDelta';
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { class: cls, subtype, severity, hop, claimId, cid, message, claim, candidate } = input;

  if (!DELTA_CLASSES.includes(cls)) fail(where, `class "${cls}" is not one of the frozen four`);
  if (typeof subtype !== 'string' || !SUBTYPE_RE.test(subtype)) fail(where, `subtype must be lower_snake_case, got ${JSON.stringify(subtype)}`);
  if (!SEVERITIES.includes(severity)) fail(where, `severity "${severity}" is not in the frozen list`);
  if (!Number.isInteger(hop) || hop < 1) fail(where, 'hop must be an integer >= 1 (the hop the corruption appeared at)');
  if (typeof claimId !== 'string' || !CLAIM_ID_RE.test(claimId)) fail(where, `claimId must match c_NNN, got ${JSON.stringify(claimId)}`);
  const m = typeof cid === 'string' ? CID_RE.exec(cid) : null;
  if (!m) fail(where, `cid must match hN_NNN, got ${JSON.stringify(cid)}`);
  if (Number(m[1]) !== hop) fail(where, `cid "${cid}" says hop ${m[1]} but hop is ${hop}`);
  if (!isNonEmptyString(message)) fail(where, 'message must be a non-empty plain-English statement of what changed');

  let evidence = input.evidence;
  if (evidence === undefined || evidence === null) {
    if (!claim || !candidate) {
      fail(where, 'evidence is required — pass {origin, restatement} pointers, or pass the claim and candidate objects and they will be derived');
    }
    evidence = { origin: pointerOf(claim, `${where}.claim`), restatement: pointerOf(candidate, `${where}.candidate`) };
  }
  if (!isPlainObject(evidence)) fail(where, 'evidence must be {origin, restatement}');
  const origin = validatePointer(evidence.origin, 'evidence.origin', where);
  const restatement = validatePointer(evidence.restatement, 'evidence.restatement', where);

  const delta = {
    class: cls,
    subtype,
    severity,
    hop,
    claimId,
    cid,
    message,
    evidence: { origin, restatement }
  };

  if (input.consequential !== undefined) {
    if (typeof input.consequential !== 'boolean') fail(where, 'consequential, when present, must be a boolean');
    delta.consequential = input.consequential;
  }
  if (input.consistentDownstream !== undefined) {
    if (typeof input.consistentDownstream !== 'boolean') fail(where, 'consistentDownstream, when present, must be a boolean');
    delta.consistentDownstream = input.consistentDownstream;
  }
  return delta;
}

/* -------------------------------------------------------------------------- */
/* Receipts                                                                   */
/* -------------------------------------------------------------------------- */

/** A candidate we declined to align, and why. Not a failure log — a receipt. */
export function makeUnaligned(cid, reason, detail) {
  const where = 'makeUnaligned';
  if (typeof cid !== 'string' || !CID_RE.test(cid)) fail(where, `cid must match hN_NNN, got ${JSON.stringify(cid)}`);
  if (!UNALIGNED_REASONS.includes(reason)) fail(where, `reason "${reason}" is not in the frozen list`);
  const entry = { cid, reason };
  if (detail !== undefined) {
    if (!isNonEmptyString(detail)) fail(where, 'detail, when present, must be a non-empty string');
    entry.detail = detail;
  }
  return entry;
}

/** An origin claim that found no restatement downstream, and why. */
export function makeDroppedClaim(claimId, reason, detail) {
  const where = 'makeDroppedClaim';
  if (typeof claimId !== 'string' || !CLAIM_ID_RE.test(claimId)) fail(where, `claimId must match c_NNN, got ${JSON.stringify(claimId)}`);
  if (!DROPPED_CLAIM_REASONS.includes(reason)) fail(where, `reason "${reason}" is not in the frozen list`);
  const entry = { claimId, reason };
  if (detail !== undefined) {
    if (!isNonEmptyString(detail)) fail(where, 'detail, when present, must be a non-empty string');
    entry.detail = detail;
  }
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Canonical ordering — verification test #16                                 */
/* -------------------------------------------------------------------------- */

function cmpStr(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * The one canonical order for alignments. Lives here, not in report.js, so it
 * is a contract rather than a negotiation between two agents at hour 8.
 * Shuffling the candidate list must not change the report — test #16.
 */
export function compareAlignments(a, b) {
  if (a.hop !== b.hop) return a.hop - b.hop;
  const c = cmpStr(a.claimId, b.claimId);
  if (c !== 0) return c;
  return cmpStr(a.cid, b.cid);
}

/** The one canonical order for deltas. Class order is DELTA_CLASSES order. */
export function compareDeltas(a, b) {
  if (a.hop !== b.hop) return a.hop - b.hop;
  const c = cmpStr(a.claimId, b.claimId);
  if (c !== 0) return c;
  const k = DELTA_CLASSES.indexOf(a.class) - DELTA_CLASSES.indexOf(b.class);
  if (k !== 0) return k;
  const s = cmpStr(a.subtype, b.subtype);
  if (s !== 0) return s;
  return cmpStr(a.cid, b.cid);
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The whole result of checking one chain. This is what the UI renders, what the
 * stake contract is shown, and what determinism is asserted over.
 *
 * It carries NO timestamp and NO generated identifier — see decision 5. Arrays
 * are sorted into canonical order here, so the caller cannot make the report
 * depend on the order it happened to iterate in.
 *
 * `dropped_claims` keeps its snake_case name from the frozen draft;
 * `droppedClaims` is accepted as a tolerant alias so a near-miss does not throw
 * at hour 8. The emitted key is always `dropped_claims`.
 */
export function makeReport(input) {
  const where = 'makeReport';
  if (!isPlainObject(input)) fail(where, 'expected an object');
  const { alignments, deltas, unaligned, dropped_claims, droppedClaims } = input;
  const dropped = dropped_claims ?? droppedClaims;

  if (!Array.isArray(alignments)) fail(where, 'alignments must be an array');
  if (!Array.isArray(deltas)) fail(where, 'deltas must be an array');
  if (!Array.isArray(unaligned)) fail(where, 'unaligned must be an array (the receipt — empty is fine, absent is not)');
  if (!Array.isArray(dropped)) fail(where, 'dropped_claims must be an array (the receipt — empty is fine, absent is not)');

  for (const [i, a] of alignments.entries()) {
    if (!isPlainObject(a) || !DECISIONS.includes(a.decision)) fail(where, `alignments[${i}] is not an Alignment (build it with makeAlignment)`);
  }
  for (const [i, d] of deltas.entries()) {
    if (!isPlainObject(d) || !DELTA_CLASSES.includes(d.class)) fail(where, `deltas[${i}] is not a Delta (build it with makeDelta)`);
    if (!isPlainObject(d.evidence)) fail(where, `deltas[${i}] carries no evidence pointers`);
  }
  for (const [i, u] of unaligned.entries()) {
    if (!isPlainObject(u) || !UNALIGNED_REASONS.includes(u.reason)) fail(where, `unaligned[${i}] needs a reason from the frozen list (build it with makeUnaligned)`);
  }
  for (const [i, d] of dropped.entries()) {
    if (!isPlainObject(d) || !DROPPED_CLAIM_REASONS.includes(d.reason)) fail(where, `dropped_claims[${i}] needs a reason from the frozen list (build it with makeDroppedClaim)`);
  }

  // An ambiguous alignment must not have spoken. Decision 3, enforced.
  const ambiguous = new Set(alignments.filter((a) => a.decision === 'ambiguous').map((a) => `${a.claimId} ${a.cid}`));
  for (const d of deltas) {
    if (ambiguous.has(`${d.claimId} ${d.cid}`)) {
      fail(where, `delta ${d.class} on ${d.claimId}/${d.cid} was emitted from an AMBIGUOUS alignment — an unaligned row is honest, a confident delta from a guess is not`);
    }
  }

  return {
    contract_version: CONTRACT_VERSION,
    alignments: [...alignments].sort(compareAlignments),
    deltas: [...deltas].sort(compareDeltas),
    unaligned: [...unaligned].sort((a, b) => cmpStr(a.cid, b.cid)),
    dropped_claims: [...dropped].sort((a, b) => cmpStr(a.claimId, b.claimId))
  };
}
