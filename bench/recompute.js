/**
 * bench/recompute.js — re-derive the benchmark's ground truth from primary
 * data and report whether the fixture has gone stale.
 *
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * This project's own corpus taught it, expensively, that every figure anybody
 * writes down is obsolete the moment it is written. The benchmark's
 * `ground_truth_recompute` block is not exempt — during the single session
 * that built it, the distinct-dispatch count moved from 311 to 313.
 *
 * So the fixture does not get to assert its ground truth. It gets to record
 * when it was last checked, and this script tells you whether that is still
 * true. Run it before quoting any number from instances.json.
 *
 *   node bench/recompute.js          # compare and report drift
 *   node bench/recompute.js --write  # update the fixture's stamped block
 *
 * This is the smallest possible working version of the STALE_EVIDENCE state
 * that PROJECT-REFERENCE.md §7 limitation 2 says BATON does not have. It is
 * deliberately outside packages/align: it is a fixture-maintenance tool, not
 * a claim that BATON re-verifies its own evidence. It does not.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'benchmark', 'instances.json');
const WRITE = process.argv.includes('--write');

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const SOURCE = fixture.ground_truth_recompute.source;

let raw;
try {
  raw = readFileSync(SOURCE, 'utf8');
} catch (e) {
  console.error(`\ncannot read primary data at ${SOURCE}`);
  console.error(`  ${e.message}`);
  console.error('\nThe benchmark still runs (bench/run.js needs no external data) but its');
  console.error('ground-truth block cannot be re-verified on this machine. Treat every');
  console.error('figure in `ground_truth_recompute` as UNVERIFIED rather than current.\n');
  process.exit(2);
}

/* Deduplicate on `key`, last-write-wins — the fixture's stated method. */
const recs = new Map();
for (const line of raw.split(/\r?\n/)) {
  const s = line.trim();
  if (!s) continue;
  let r;
  try { r = JSON.parse(s); } catch { continue; }
  if (r && r.key) recs.set(r.key, r);
}

const all = [...recs.values()];
const dates = all.map((r) => String(r.started_at ?? '').slice(0, 10)).filter(Boolean).sort();
const earliest = dates[0];
const latest = dates[dates.length - 1];
const spanDays = Math.round((new Date(latest) - new Date(earliest)) / 86400000);

const byAgent = new Map();
for (const r of all) {
  const a = r.agent ?? '?';
  const e = byAgent.get(a) ?? { n: 0, ok: 0 };
  e.n += 1;
  if (r.status === 'completed') e.ok += 1;
  byAgent.set(a, e);
}

let guardsFalse = 0;
let guardsAbsent = 0;
for (const r of all) {
  if (r.guards == null) guardsAbsent += 1;
  else if (!r.guards.present) guardsFalse += 1;
}

const now = {
  distinct_dispatches: all.length,
  earliest_dispatch: earliest,
  latest_dispatch: latest,
  fleet_span_days: spanDays,
  guards_present_false: `${guardsFalse} of ${all.length} (${guardsAbsent} records carry no \`guards\` field at all)`,
  per_agent_completion: Object.fromEntries(
    ['friday', 'edith', 'zeus', 'beastboy', 'pete']
      .filter((a) => byAgent.has(a))
      .map((a) => {
        const { n, ok } = byAgent.get(a);
        return [a, `${ok}/${n} = ${Math.round((100 * ok) / n)}%`];
      })
  )
};

const was = fixture.ground_truth_recompute;
const drift = [];
const cmp = (k, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) drift.push([k, a, b]); };

cmp('distinct_dispatches', was.distinct_dispatches, now.distinct_dispatches);
cmp('fleet_span_days', was.fleet_span_days, now.fleet_span_days);
cmp('latest_dispatch', was.latest_dispatch, now.latest_dispatch);
cmp('guards_present_false', was.guards_present_false, now.guards_present_false);
for (const a of Object.keys(now.per_agent_completion)) {
  cmp(`per_agent_completion.${a}`, was.per_agent_completion?.[a], now.per_agent_completion[a]);
}

console.log('');
console.log(`benchmark ground truth — last stamped ${was.stamped}`);
console.log(`primary data: ${SOURCE}`);
console.log('─'.repeat(72));

if (drift.length === 0) {
  console.log('NO DRIFT — every stamped figure still recomputes to the same value.');
} else {
  console.log(`STALE — ${drift.length} figure(s) have moved since the fixture was stamped:\n`);
  for (const [k, a, b] of drift) console.log(`  ${k.padEnd(34)} stamped ${String(a).padEnd(22)} now ${b}`);
  console.log('\nThis is limitation 2 (evidence staleness) demonstrated on the benchmark itself.');
  console.log('BATON cannot detect this. Only recomputation from primary data can, which is');
  console.log('exactly the argument for why origin truth is outside the trust boundary.');
  if (WRITE) {
    Object.assign(fixture.ground_truth_recompute, now, {
      stamped: new Date().toISOString().slice(0, 10)
    });
    writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
    console.log('\n--write given: fixture ground-truth block updated and re-stamped.');
  } else {
    console.log('\nRe-run with --write to update the fixture.');
  }
}
console.log('');
process.exit(drift.length ? 1 : 0);
