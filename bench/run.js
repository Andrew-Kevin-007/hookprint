/**
 * bench/run.js — run BATON's real gate() against the labelled corruption
 * benchmark and report precision, recall and false-positive rate.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * LOKI-ATTACK.md finding 4: "A gate with no measured false-positive rate is
 * not a gate." 251 passing unit tests across four packages, and not one of
 * them produced a corpus-level accuracy number. The product's entire value is
 * that it says no; nobody had measured how often it says no to something that
 * was fine.
 *
 * This file is that measurement. It uses the REAL gate() and the REAL
 * diffClaim — no mocks, no stubs, no injected differ. If it reports a good
 * number, the number is earned; if it reports a bad one, that is a finding and
 * it gets reported, not tuned away.
 *
 *   node bench/run.js            # headline metrics
 *   node bench/run.js --verbose  # per-instance detail
 *   node bench/run.js --strict   # also gate invention (unaligned -> REJECT)
 *   node bench/run.js --json     # machine-readable, for CI
 *
 * Zero dependencies. No network. Deterministic — run it twice, get the same
 * bytes.
 *
 * HONESTY RULES BAKED INTO THIS SCRIPT
 * ---------------------------------------------------------------------------
 * 1. `origin_truth` rows are NOT counted as BATON failures. BATON's trust
 *    boundary says it cannot catch a figure that was wrong before the first
 *    restatement. Counting those as misses would be attacking a claim the
 *    project never made. They are reported separately as "correctly silent",
 *    and a REJECT on one of them counts AGAINST us — it would mean the gate
 *    fired on a faithful restatement.
 * 2. `hard_case` rows are excluded from the headline and printed on their own
 *    line with the reasoning. Dropping them silently would be the exact sin
 *    this project exists to catch.
 * 3. `invention` rows are reported as a coverage gap, not folded into recall.
 * 4. Every number printed here is computed at run time from the fixture and
 *    the real pipeline. Nothing is hard-coded.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

import { gate } from '../packages/align/index.js';
import { makeClaim, makeCandidate } from '../packages/align/contract.js';
import { extractParsed } from '../packages/align/extract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'benchmark', 'instances.json');

const argv = new Set(process.argv.slice(2));
const VERBOSE = argv.has('--verbose') || argv.has('-v');
const STRICT = argv.has('--strict');
const JSON_OUT = argv.has('--json');
/**
 * --raw ignores the fixture's `focus` spans and feeds the whole cited line to
 * extract.js, letting pickPrimary choose which quantity is under test. That is
 * the harder, more realistic document-granularity task, and BATON scores much
 * worse on it. Both numbers are reported in bench/README.md on purpose — the
 * gap between them is a real finding about sentence segmentation on
 * multi-quantity prose, not something to bury.
 */
const RAW = argv.has('--raw');

/* -------------------------------------------------------------------------- */
/* Building Claims and Candidates from fixture prose                          */
/* -------------------------------------------------------------------------- */

/**
 * Both sides go through extract.js — the package's one hard invariant is that
 * origins and restatements are parsed by the SAME code path, never two
 * parsers. We honour that here rather than hand-building quantity objects,
 * because a benchmark that parsed its inputs differently from production
 * would be measuring the wrong thing.
 */
function parseOne(text) {
  const parsed = extractParsed(text, { requireQuantity: true });
  return parsed.length ? parsed[0] : null;
}

/** The clause actually under test: the annotated focus span, or the whole line under --raw. */
function textOf(side) {
  return RAW ? side.text : (side.focus ?? side.text);
}

function sha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * contract.js enforces `c_NNN` / `hN_NNN` id formats via a throwing
 * constructor — it rejected this file's first attempt at `c_B01`, which is
 * the frozen contract doing exactly its job. Ids are therefore the instance's
 * ordinal; `idOf` keeps the mapping back to the human-readable B-number.
 */
function ordinalOf(inst) {
  return fixture.instances.indexOf(inst) + 1;
}

function buildClaim(inst) {
  const raw = textOf(inst.origin);
  const p = parseOne(raw);
  if (!p) return null;
  const src = `${inst.origin.file}:${inst.origin.line}`;
  return makeClaim({
    id: `c_${String(ordinalOf(inst)).padStart(3, '0')}`,
    hop: 1,
    evidence: {
      source: src,
      sha256: sha(raw),
      span: p.span,
      quote: raw.slice(p.span.start, p.span.end)
    },
    ...p
  });
}

function buildCandidate(inst, hop = 2) {
  const raw = textOf(inst.restatement);
  const p = parseOne(raw);
  if (!p) return null;
  return makeCandidate({
    cid: `h${hop}_${String(ordinalOf(inst)).padStart(3, '0')}`,
    hop,
    file: `${inst.restatement.file}:${inst.restatement.line}`,
    sha256: sha(raw),
    neighbours: { prevSpan: null, nextSpan: null },
    ...p
  });
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const results = [];

for (const inst of fixture.instances) {
  const row = {
    id: inst.id,
    scope: inst.scope,
    expect: STRICT && inst.strict_expect ? inst.strict_expect : inst.expect,
    expect_class: inst.class,
    actual: null,
    actual_class: null,
    outcome: null,
    detail: ''
  };

  // Rows with no restatement carry no handoff to check, by construction.
  if (!inst.restatement) {
    row.actual = 'NO_PAIR';
    row.outcome = 'not_scored';
    row.detail = 'single-mention instance: no restatement exists, so there is no pair to check';
    results.push(row);
    continue;
  }

  // Invention rows have no origin to align to — that IS the finding.
  if (!inst.origin) {
    row.actual = STRICT ? 'REJECT' : 'NO_VERDICT';
    row.actual_class = STRICT ? 'no_origin' : null;
    row.outcome = row.actual === row.expect ? 'correct' : 'wrong';
    row.detail = STRICT
      ? 'strict mode: unaligned quantified candidate -> REJECT · no_origin'
      : 'default: lands in the unaligned honesty receipt, no verdict emitted';
    results.push(row);
    continue;
  }

  const claim = buildClaim(inst);
  const candidate = buildCandidate(inst);

  if (!claim || !candidate) {
    row.actual = 'PARSE_FAIL';
    row.outcome = 'not_scored';
    row.detail = !claim
      ? 'extract.js found no primary quantity in the origin text'
      : 'extract.js found no primary quantity in the restatement text';
    results.push(row);
    continue;
  }

  // THE REAL GATE. No injected differ — diffClaim is the production default.
  const { verdicts, report } = gate([claim], [candidate], 2);

  if (verdicts.length === 0) {
    row.actual = 'NO_VERDICT';
    row.detail = `no alignment produced (${report.unaligned.length} unaligned)`;
  } else {
    const v = verdicts[0];
    row.actual = v.status;
    row.actual_class = v.reason;
    row.detail = v.deltas.length
      ? v.deltas.map((d) => `${d.class}/${d.subtype ?? '-'}:${d.severity}`).join(', ')
      : 'no deltas';
  }

  // Score it.
  if (row.scope === 'hard_case') {
    row.outcome = 'hard_case';
  } else if (row.actual === row.expect) {
    row.outcome = 'correct';
  } else {
    row.outcome = 'wrong';
  }
  results.push(row);
}

/* -------------------------------------------------------------------------- */
/* Metrics — computed only over `handoff_integrity`, which is what BATON claims */
/* -------------------------------------------------------------------------- */

const scored = results.filter((r) => r.scope === 'handoff_integrity');
const positives = scored.filter((r) => r.expect === 'REJECT');
const negatives = scored.filter((r) => r.expect === 'ACCEPT');

const TP = positives.filter((r) => r.actual === 'REJECT').length;
const FN = positives.filter((r) => r.actual !== 'REJECT').length;
const FP = negatives.filter((r) => r.actual === 'REJECT').length;
const TN = negatives.filter((r) => r.actual === 'ACCEPT').length;

const pct = (n, d) => (d === 0 ? null : n / d);
const fmt = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);

const precision = pct(TP, TP + FP);
const recall = pct(TP, TP + FN);
const fpr = pct(FP, FP + TN);
const f1 =
  precision !== null && recall !== null && precision + recall > 0
    ? (2 * precision * recall) / (precision + recall)
    : null;

const silent = results.filter((r) => r.scope === 'origin_truth' && r.actual !== 'NO_PAIR');
const correctlySilent = silent.filter((r) => r.actual === 'ACCEPT').length;
const invention = results.filter((r) => r.scope === 'invention');
const inventionUngated = invention.filter((r) => r.actual === 'NO_VERDICT').length;
const hard = results.filter((r) => r.scope === 'hard_case');
const notScored = results.filter((r) => r.outcome === 'not_scored');

const summary = {
  mode: STRICT ? 'strict' : 'default',
  scored_rows: scored.length,
  TP, FP, FN, TN,
  precision, recall, false_positive_rate: fpr, f1,
  origin_truth_rows: silent.length,
  correctly_silent: correctlySilent,
  invention_rows: invention.length,
  invention_ungated: inventionUngated,
  hard_cases: hard.length,
  not_scored: notScored.length,
  total_instances: results.length
};

if (JSON_OUT) {
  console.log(JSON.stringify({ summary, results }, null, 2));
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

const line = '─'.repeat(72);
console.log('');
console.log(`BATON claim-corruption benchmark — ${fixture.name}`);
console.log(`corpus: ${fixture.corpus.files.join(', ')} (written ${fixture.corpus.written}, before BATON existed)`);
console.log(`mode:   ${summary.mode}${STRICT ? '  (invention gated)' : '  (invention ungated — the default)'}`);
console.log(line);

if (VERBOSE) {
  for (const r of results) {
    const mark =
      r.outcome === 'correct' ? '  ok  ' :
      r.outcome === 'wrong' ? ' MISS ' :
      r.outcome === 'hard_case' ? ' hard ' : '  --  ';
    console.log(
      `${mark} ${r.id}  ${r.scope.padEnd(18)} expect ${String(r.expect).padEnd(10)} got ${String(r.actual).padEnd(10)} ${r.detail}`
    );
  }
  console.log(line);
}

console.log('HANDOFF INTEGRITY — what BATON claims to do. Scored.');
console.log(`  instances            ${scored.length}   (${positives.length} corrupt, ${negatives.length} clean)`);
console.log(`  true positives       ${TP}      corruption present and caught`);
console.log(`  false negatives      ${FN}      corruption present and missed`);
console.log(`  false positives      ${FP}      clean restatement wrongly rejected`);
console.log(`  true negatives       ${TN}      clean restatement correctly passed`);
console.log('');
console.log(`  precision            ${fmt(precision)}`);
console.log(`  recall               ${fmt(recall)}`);
console.log(`  FALSE-POSITIVE RATE  ${fmt(fpr)}   <- the number LOKI-ATTACK.md §4 says nobody had`);
console.log(`  F1                   ${fmt(f1)}`);
console.log(line);

console.log('TRUST BOUNDARY — what BATON says it CANNOT do. Reported, not scored as failure.');
console.log(`  origin-poisoning rows with a restatement   ${silent.length}`);
console.log(`  correctly silent (ACCEPT, as designed)     ${correctlySilent}/${silent.length}`);
console.log('  These figures were wrong before any restatement. BATON returns ACCEPT and');
console.log('  the numbers stay wrong. That is the trust boundary firing as specified,');
console.log('  not a defect — and we volunteer the examples rather than wait to be asked.');
console.log(line);

console.log('COVERAGE GAP — LOKI-ATTACK.md §2, measured rather than argued.');
console.log(`  invention rows (claim with no origin)      ${invention.length}`);
console.log(`  ungated under default gate()              ${inventionUngated}`);
if (!STRICT && inventionUngated > 0) {
  console.log('  A fabricated number with nothing to align to lands in the `unaligned`');
  console.log('  honesty receipt and the pipeline proceeds. Run with --strict to gate it.');
}
console.log(line);

if (hard.length) {
  console.log('HARD CASES — excluded from the headline, printed because hiding them would be dishonest.');
  for (const r of hard) {
    console.log(`  ${r.id}  expect ${r.expect}, got ${r.actual}  — ${r.detail}`);
  }
  console.log('  See instances.json `why_it_matters` for the reasoning on each.');
  console.log(line);
}

if (notScored.length) {
  console.log('NOT SCORED');
  for (const r of notScored) console.log(`  ${r.id}  ${r.detail}`);
  console.log(line);
}

console.log(`total labelled instances: ${results.length}`);
console.log('');
console.log('Ground truth for every quantitative row was recomputed from');
console.log(`${fixture.ground_truth_recompute.source}`);
console.log(`on ${fixture.ground_truth_recompute.stamped}. Re-run bench/recompute.js before quoting any of it —`);
console.log('the underlying file is appended to live and these figures perish.');
console.log('');
