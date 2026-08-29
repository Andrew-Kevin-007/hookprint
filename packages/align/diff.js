/**
 * diff.js — compare an aligned (claim, candidate) pair and emit the four delta
 * classes: value_drift, unit_drift, denominator_loss, caveat_loss.
 * Denominator first — it is the differentiator.
 *
 * Owns: (Claim, Candidate) -> Delta[]. Depends on: contract.js only.
 *
 * This module is only ever called for a `matched` alignment. `makeReport`
 * (contract.js) refuses a Delta whose alignment decision was `ambiguous` as a
 * structural backstop, but the caller (align.js / index.js) should not invoke
 * `diffClaim` for an ambiguous pair in the first place — diff.js itself does
 * not see an Alignment object, only the two parsed sides.
 *
 * Convention this file relies on (not stated in contract.js, so stated here):
 * for `dimension: 'percent'`, `Quantity.value` is a FRACTION (0.79 means
 * "0.79%", i.e. 2/252), not a 0-100 number. That is the only reading under
 * which `arithmeticallyConsistent` below — numerator/denominator compared
 * directly against `quantity.value` with an absolute 0.01 tolerance — can ever
 * call the real 2-of-252 = 0.79% baseline "consistent". Every quantity built
 * or compared in this file follows that convention. Display text should
 * always come from `quantity.raw` (the literal source token), never be
 * reconstructed from `.value`, so this convention never leaks into a message.
 */

import { makeDelta } from './contract.js';

/* -------------------------------------------------------------------------- */
/* Small numeric/text primitives — kept local and dependency-free on purpose  */
/* -------------------------------------------------------------------------- */

/** "Basically the same number" tolerance, as a fraction of the larger magnitude. */
const SAME_VALUE_TOLERANCE = 0.005;

/** Above this relative difference a value_drift is 'material' (fail vs warn). */
const MATERIAL_TOLERANCE = 0.10;

/** Trigram-similarity floor above which two unit terms are treated as the same unit. */
const UNIT_SIMILARITY_FLOOR = 0.72;

/** Relative difference between two numbers, symmetric, 0 when both are 0. */
function relDiff(a, b) {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return Math.abs(a - b) / denom;
}

/** Do two [lo, hi] bands (either bound possibly null = unbounded) overlap? */
function bandsOverlap(a, b) {
  const [loA, hiA] = a;
  const [loB, hiB] = b;
  if (hiA !== null && loB !== null && hiA < loB) return false;
  if (hiB !== null && loA !== null && hiB < loA) return false;
  return true;
}

/** Is `value` inside [lo, hi] (either bound possibly null = unbounded)? */
function inBand(value, band) {
  const [lo, hi] = band;
  if (lo !== null && value < lo) return false;
  if (hi !== null && value > hi) return false;
  return true;
}

/**
 * Minimal suffix-stripping stemmer. Deliberately not lexicon.js — this package
 * is being built in isolation from the stream that owns it, and diff.js needs
 * only enough stemming to tell "dispatch"/"dispatches" apart from "reviewers".
 */
function stem(word) {
  const w = String(word).toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  return w;
}

/** Character-trigram Dice coefficient, 0..1. Short strings degrade gracefully. */
function trigramDice(a, b) {
  const grams = (s) => {
    const t = `  ${String(s).toLowerCase()}  `;
    const out = [];
    for (let i = 0; i < t.length - 2; i++) out.push(t.slice(i, i + 3));
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.length === 0 || gb.length === 0) return ga.length === gb.length ? 1 : 0;
  const bag = new Map();
  for (const g of ga) bag.set(g, (bag.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of gb) {
    const c = bag.get(g) ?? 0;
    if (c > 0) {
      common++;
      bag.set(g, c - 1);
    }
  }
  return (2 * common) / (ga.length + gb.length);
}

/** Are two Magnitude units the same base? Null==null counts as compatible. */
function unitCompatible(od, cd) {
  if (od.unit === null && cd.unit === null) return true;
  if (od.unit === null || cd.unit === null) return false;
  if (stem(od.unit) === stem(cd.unit)) return true;
  return trigramDice(od.unit, cd.unit) >= UNIT_SIMILARITY_FLOOR;
}

/** Literal source token — never reconstruct display text from `.value`. */
function fmtQuantity(q) {
  return q.raw;
}

/** "252 dispatches" / "252" (no "null" leaking when a Magnitude has no unit). */
function fmtMag(m) {
  return m.unit ? `${m.value} ${m.unit}` : `${m.value}`;
}

/**
 * The single most impressive line of output in the whole project.
 *
 * True exactly when a candidate's own numerator/denominator recompute the rate
 * it displays — i.e. the corrupted base was carried through consistently, so
 * the restated percentage looks internally coherent even though the base
 * underneath it moved. That is what makes an altered denominator dangerous
 * rather than merely wrong: nothing about the restatement looks broken on its
 * own.
 */
function arithmeticallyConsistent(candidate) {
  if (!candidate.numerator || !candidate.denominator || candidate.denominator.value === 0) return false;
  if (!candidate.quantity) return false;
  if (candidate.quantity.dimension !== 'percent' && candidate.quantity.dimension !== 'ratio') return false;
  return Math.abs(candidate.numerator.value / candidate.denominator.value - candidate.quantity.value) <= 0.01;
}

/* -------------------------------------------------------------------------- */
/* diffDenominator — THE DIFFERENTIATOR                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE RULE: denominator loss is reportable only when the origin claim stated a
 * base. If `claim.denominator` is null, denominator loss is structurally
 * unreachable for that claim — never infer a missing denominator from
 * downstream text alone.
 *
 * Returns an array of delta specs: {class, subtype, severity, message,
 * consequential?, consistentDownstream?} — hop/claimId/cid/evidence are added
 * by `diffClaim`, not here.
 */
export function diffDenominator(claim, candidate) {
  if (claim.denominator == null) return [];

  const od = claim.denominator;
  const cd = candidate.denominator;

  if (cd == null) {
    const cq = candidate.quantity;
    const rateSurvives = Boolean(cq) && (cq.dimension === 'percent' || cq.dimension === 'ratio' || cq.vague === true);
    if (rateSurvives) {
      return [
        {
          class: 'denominator_loss',
          subtype: 'dropped_rate_survives',
          severity: 'fail',
          message: `origin computed ${fmtQuantity(claim.quantity)} over ${fmtMag(od)}; the restatement presents the rate with no base`
        }
      ];
    }
    const num = claim.numerator ? claim.numerator.value : '?';
    return [
      {
        class: 'denominator_loss',
        subtype: 'dropped_count_only',
        severity: 'warn',
        message: `origin stated ${num} of ${fmtMag(od)}; the restatement keeps the count and drops the base`
      }
    ];
  }

  const sameValue = relDiff(od.value, cd.value) <= SAME_VALUE_TOLERANCE;
  const sameUnit = unitCompatible(od, cd);
  if (sameValue && sameUnit) return []; // base intact

  if (!sameValue) {
    const consistentDownstream = arithmeticallyConsistent(candidate);
    const deltas = [
      {
        class: 'denominator_loss',
        subtype: 'altered',
        severity: 'fail',
        consistentDownstream,
        message: `base changed ${fmtMag(od)} -> ${fmtMag(cd)}`
      }
    ];
    if (consistentDownstream) {
      deltas.push({
        class: 'value_drift',
        subtype: 'consequential_on_denominator',
        severity: 'warn',
        consequential: true,
        message:
          'the restated percentage is arithmetically consistent with the altered base — which is exactly why it does not read as wrong on its face'
      });
    }
    return deltas;
  }

  // same value, different unit: the base was re-attributed to a different thing
  return [
    {
      class: 'denominator_loss',
      subtype: 'rebased',
      severity: 'fail',
      message: `base re-attributed: ${fmtMag(od)} -> ${fmtMag(cd)}`
    }
  ];
}

/* -------------------------------------------------------------------------- */
/* diffValue                                                                  */
/* -------------------------------------------------------------------------- */

export function diffValue(claim, candidate) {
  const oq = claim.quantity;
  const cq = candidate.quantity;
  if (!cq) return [];

  if (!oq.vague && !cq.vague) {
    const rel = relDiff(oq.value, cq.value);
    if (rel <= SAME_VALUE_TOLERANCE) return [];
    if (bandsOverlap(oq.band, cq.band)) {
      return [
        {
          class: 'value_drift',
          subtype: 'rounding',
          severity: 'note',
          message: `restated ${cq.raw} is within rounding of origin ${oq.raw}`
        }
      ];
    }
    const severity = rel > MATERIAL_TOLERANCE ? 'fail' : 'warn';
    return [
      {
        class: 'value_drift',
        subtype: 'material',
        severity,
        message: `value drifted from ${oq.raw} to ${cq.raw}`
      }
    ];
  }

  if (cq.vague) {
    // e.g. "44%" restated as "nearly half" — not a corruption if 44% is
    // exactly the kind of thing "nearly half" was willing to cover.
    if (inBand(oq.value, cq.band)) {
      return [
        {
          class: 'value_drift',
          subtype: 'precision_loss',
          severity: 'note',
          message: `origin's exact ${oq.raw} is restated only as "${cq.raw}", which still covers it`
        }
      ];
    }
    return [
      {
        class: 'value_drift',
        subtype: 'material',
        severity: 'fail',
        message: `origin's ${oq.raw} falls outside the band "${cq.raw}" implies`
      }
    ];
  }

  // origin itself vague (no exact number to check) and candidate is exact:
  // no rule defines a corruption here, so no finding.
  return [];
}

/* -------------------------------------------------------------------------- */
/* diffUnit                                                                   */
/* -------------------------------------------------------------------------- */

export function diffUnit(claim, candidate) {
  const cu = claim.unit;
  const du = candidate.unit;

  if (cu == null || du == null) {
    if (cu != null && du == null) {
      return [
        {
          class: 'unit_drift',
          subtype: 'unit_dropped',
          severity: 'note',
          message: `origin's unit "${cu.term}" is absent from the restatement`
        }
      ];
    }
    return [];
  }

  if (stem(cu.term) === stem(du.term)) return [];
  if (trigramDice(cu.term, du.term) >= UNIT_SIMILARITY_FLOOR) return [];

  return [
    {
      class: 'unit_drift',
      subtype: 'measure_confusion',
      severity: 'fail',
      message: `unit changed: ${cu.term} -> ${du.term}`
    }
  ];
}

/* -------------------------------------------------------------------------- */
/* diffCaveats                                                                */
/* -------------------------------------------------------------------------- */

/**
 * diff.js's own caveat vocabulary, deliberately separate from contract.js's
 * frozen `CAVEAT_KINDS` (hedge/scope/condition/temporal/uncertainty/
 * comparison_basis/other), which classifies a `Caveat` at mint time. This
 * table classifies by TERM for the purpose of loss-detection ("origin
 * 'unverified' is satisfied by downstream 'unconfirmed' — both are the
 * uncertainty family"), and `subtype` is explicitly not frozen in the
 * contract, so this table is free to exist. A caveat whose term matches
 * nothing here falls back to its own (frozen) `.kind` field.
 */
const CAVEAT_FAMILIES = {
  uncertainty: {
    severity: 'fail',
    terms: [
      'unverified',
      'unconfirmed',
      'alleged',
      'reported',
      'reportedly',
      'claimed',
      'self-reported',
      'preliminary',
      'provisional',
      'disputed'
    ]
  },
  estimation: {
    severity: 'fail',
    terms: [
      'estimated',
      'estimate',
      'approximately',
      'approx',
      'roughly',
      'about',
      'around',
      'circa',
      '~',
      'on the order of'
    ]
  },
  scope: {
    severity: 'fail',
    terms: ['in this sample', 'among respondents', 'self-selected', 'non-random', 'n=', 'single site', 'pilot']
  },
  projection: {
    severity: 'fail',
    terms: ['projected', 'forecast', 'expected', 'target', 'goal']
  },
  modality: {
    severity: 'warn',
    terms: ['may', 'might', 'could', 'appears to', 'seems', 'suggests', 'consistent with']
  }
};

/** Which family (if any) a Caveat belongs to, by matching its term text. */
function classifyCaveat(caveat) {
  const t = caveat.term.toLowerCase();
  for (const [family, def] of Object.entries(CAVEAT_FAMILIES)) {
    if (def.terms.some((term) => t.includes(term.toLowerCase()))) return family;
  }
  return caveat.kind; // fallback to the frozen Caveat.kind if no term matched
}

export function diffCaveats(claim, candidate) {
  const deltas = [];

  const claimFamilies = new Map(); // family -> first Caveat carrying it
  for (const c of claim.caveats) {
    const fam = classifyCaveat(c);
    if (!claimFamilies.has(fam)) claimFamilies.set(fam, c);
  }

  const windowFamilies = new Set();
  for (const c of candidate.caveats) {
    windowFamilies.add(classifyCaveat(c));
  }

  for (const [fam, caveat] of claimFamilies) {
    if (!windowFamilies.has(fam)) {
      deltas.push({
        class: 'caveat_loss',
        subtype: fam,
        severity: CAVEAT_FAMILIES[fam]?.severity ?? 'warn',
        message: `origin carried a ${fam} caveat ("${caveat.term}") that is absent from the restatement`
      });
    }
  }

  const addedAlready = new Set();
  for (const c of candidate.caveats) {
    const fam = classifyCaveat(c);
    if (!claimFamilies.has(fam) && !addedAlready.has(fam)) {
      addedAlready.add(fam);
      deltas.push({
        class: 'caveat_loss',
        subtype: `added_${fam}`,
        severity: 'note',
        message: `the restatement introduces a ${fam} caveat ("${c.term}") the origin did not carry`
      });
    }
  }

  return deltas;
}

/* -------------------------------------------------------------------------- */
/* Top-level export                                                           */
/* -------------------------------------------------------------------------- */

/**
 * An aligned (claim, candidate) pair -> Delta[], fully constructed and
 * validated through `contract.js`'s `makeDelta`.
 *
 * `hop` defaults to `candidate.hop` (the hop the corruption appeared at) since
 * every candidate already carries it; a caller may still pass it explicitly.
 *
 * Evidence is derived by `makeDelta` itself from the raw `claim`/`candidate`
 * objects (via `pointerOf`) rather than hand-built here, because `Claim.
 * evidence` uses the field name `source` while a `Pointer` uses `file` —
 * `pointerOf` is the one place that translation is allowed to live.
 */
export function diffClaim(claim, candidate, hop = candidate.hop) {
  const specs = [
    ...diffDenominator(claim, candidate),
    ...diffValue(claim, candidate),
    ...diffUnit(claim, candidate),
    ...diffCaveats(claim, candidate)
  ];

  return specs.map((spec) =>
    makeDelta({
      ...spec,
      hop,
      claimId: claim.id,
      cid: candidate.cid,
      claim,
      candidate
    })
  );
}
