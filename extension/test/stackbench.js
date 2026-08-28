// Measures the real cost of the OpenWPM call-site technique on V8.
// Run: node extension/test/stackbench.js
// This number decides the hot-path sampling policy documented in src/EVENTS.md.
function deep(n, f) { return n > 0 ? deep(n - 1, f) : f(); }

function bench(label, fn, iters) {
  for (let i = 0; i < 5000; i++) fn();                 // warm
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const t1 = process.hrtime.bigint();
  const us = Number(t1 - t0) / 1000 / iters;
  console.log(label.padEnd(46) + us.toFixed(3) + " us/call");
  return us;
}

const N = 200000;
bench("baseline: empty fn call", () => {}, N);
bench("new Error() only (no .stack read)", () => new Error(), N);
bench("new Error().stack  @ depth 3", () => deep(3, () => new Error().stack), N);
bench("new Error().stack  @ depth 10", () => deep(10, () => new Error().stack), N);
bench("new Error().stack  @ depth 25", () => deep(25, () => new Error().stack), N);

const orig = Error.stackTraceLimit;
Error.stackTraceLimit = 6;
bench("new Error().stack  @ depth 25, limit=6", () => deep(25, () => new Error().stack), N);
Error.stackTraceLimit = orig;

const sample = deep(10, () => new Error().stack);
bench("split + regex parse of a captured stack", () => {
  const lines = sample.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const m = /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?$/.exec(lines[i]);
    if (m) return m[2];
  }
}, N);
