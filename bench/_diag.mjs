import { extractParsed } from '../packages/align/extract.js';
import { readFileSync } from 'node:fs';

const fx = JSON.parse(readFileSync(new URL('../fixtures/benchmark/instances.json', import.meta.url), 'utf8'));

for (const inst of fx.instances) {
  for (const side of ['origin', 'restatement']) {
    const o = inst[side];
    if (!o) continue;
    const p = extractParsed(o.text, { requireQuantity: true });
    const q = p.length ? p[0].quantity : null;
    console.log(
      `${inst.id} ${side.padEnd(12)} sentences=${p.length} primary=` +
        (q ? `${q.numerator ?? '-'}/${q.denominator ?? '-'} val=${q.value}` : 'NONE') +
        ` unit=${p.length ? p[0].unit : '-'}`
    );
  }
  console.log('');
}
