/**
 * canonicalize.js — deterministic JSON serialization for signing.
 *
 * A signature is only meaningful if two semantically-identical objects
 * always produce the same bytes to sign. Plain JSON.stringify does not
 * guarantee that: key insertion order varies across how an object was
 * built (a Claim assembled by one code path vs. reconstructed from a
 * wire payload), and that alone would flip the signature.
 *
 * canonicalize() recursively sorts every object's keys before stringifying.
 * Arrays keep their order (order is semantic there — a claim's caveats[]
 * or a report's deltas[] mean something different reordered). No other
 * normalization: this is not meant to survive semantic-equivalent-but-
 * differently-typed values (e.g. "44" vs 44) — the contract layer already
 * enforces the shapes that go in here.
 */

export function canonicalize(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortDeep(value[key]);
    }
    return sorted;
  }
  return value;
}
