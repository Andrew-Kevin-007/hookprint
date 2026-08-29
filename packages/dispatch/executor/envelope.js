/**
 * QUORUM dispatch — executor/envelope.js
 *
 * The pivotal decision (see plan §"The pivotal decision: batches return
 * structured claims, not prose"): a batch's output must never be free
 * prose that a later step tries to regex-extract facts from — extraction on
 * free prose measures 0% precision on the raw-document path (bench/README.md).
 * Instead every batch is asked to return one typed JSON envelope:
 *
 *   { answer: "<prose for a human>",
 *     claims: [ { subject, value, unit, denominator, basis, qualifier, confidence } ] }
 *
 * This module owns two things: building the prompt that requests that shape
 * (`buildEnvelopePrompt`), and a STRICT parser for it (`parseEnvelope`) that
 * fails closed — a provider that ignores the schema is a failed batch, never
 * a silent pass. `merge/index.js` is the caller that turns a parse failure
 * into an `INCOMPLETE` route status rather than a hidden gap.
 */

/** The three qualifier values a claim may carry (`null` is also legal — no comment on precision). */
export const ENVELOPE_QUALIFIERS = Object.freeze(['measured', 'estimated', 'projected']);

/** Fields a claim MUST carry — missing any one of these fails the WHOLE batch, per the plan's fail-closed contract. */
const REQUIRED_CLAIM_FIELDS = Object.freeze(['subject', 'value', 'unit']);

const ENVELOPE_SCHEMA_TEXT = `{
  "answer": "<prose for a human to read>",
  "claims": [
    {
      "subject": "<what this number is about, e.g. 'dispatch records with a confidence value'>",
      "value": <number>,
      "unit": "<e.g. 'records', 'percent', 'dollars'>",
      "denominator": <number|null>,
      "basis": "<what the denominator counts, e.g. 'all dispatches', or null>",
      "qualifier": "measured"|"estimated"|"projected"|null,
      "confidence": <0-1 float, YOUR OWN confidence in this specific claim>
    }
  ]
}`;

/**
 * Build the prompt that asks a provider to return the envelope shape above.
 *
 * `batchContent` is the batch's already-built prompt body — e.g. the output
 * of `executor/index.js`'s `buildPromptFromBatch()` — this function wraps
 * it, it does not reconstruct it. `task` carries task-level context (only
 * `kind` is used) purely to phrase the instruction; it is never required to
 * match any particular shape.
 *
 * No provider-specific JSON-mode / tool-schema request is issued here:
 * `executor/anthropic.js`'s `messages.create()` and `executor/openai.js`'s
 * `chat.completions.create()` calls, as currently wired through
 * `executeBatch()`, pass neither a `response_format` nor a tool schema — so
 * this is a prompt-level instruction that works identically against every
 * provider adapter registered in `executor/index.js`, current or future
 * (per the task brief, other providers may be added in a parallel worktree;
 * this fallback needs no knowledge of which providers exist). A caller
 * wiring up a provider that DOES support an enforced JSON mode can still do
 * so via that adapter's own `call()` options — this function's job ends at
 * the instruction text, which doubles as the fallback for everyone else.
 *
 * @param {string} batchContent
 * @param {{ kind?: string }} [task]
 * @returns {string}
 */
export function buildEnvelopePrompt(batchContent, task = {}) {
  const kind = typeof task?.kind === 'string' && task.kind.length > 0 ? task.kind : 'document-analysis';
  const body = typeof batchContent === 'string' ? batchContent : String(batchContent ?? '');

  return `${body}

---
Task kind: ${kind}. Respond with ONLY a single JSON object — no prose before or after it, no markdown code fences — matching EXACTLY this shape:

${ENVELOPE_SCHEMA_TEXT}

Rules:
- "claims" must be an array (empty if this batch contains no quantified facts worth checking).
- Every claim MUST include "subject", "value", and "unit". Set "denominator"/"basis" to null when there is no base the value was computed over.
- "confidence" is YOUR OWN estimate of how sure you are in that specific claim, not the overall answer.
- Do not wrap the JSON in a markdown code fence. Do not add any commentary before or after it.
- If you cannot produce any claims, still return valid JSON with "claims": [].`;
}

/**
 * Parse a batch's raw output against the envelope schema. STRICT and
 * fail-closed: any structural problem fails the WHOLE batch with a clear
 * `reason` — this never attempts a partial parse or a regex fallback onto
 * prose, because that would defeat the entire point of requiring structured
 * output (see plan §"The pivotal decision"). In particular, a JSON payload
 * wrapped in a markdown code fence (some providers add one despite being
 * told not to) is a failed batch here, not a salvage target — deliberately:
 * a provider that decorates its output ignored the explicit "no markdown
 * fences" instruction, which is exactly the "ignored the schema" signal
 * this parser exists to surface rather than paper over.
 *
 * @param {string} rawOutput
 * @returns {{ valid: boolean, envelope: {answer: string, claims: object[]}|null, reason: string|null }}
 */
export function parseEnvelope(rawOutput) {
  if (typeof rawOutput !== 'string' || rawOutput.trim().length === 0) {
    return { valid: false, envelope: null, reason: 'output is empty or not a string — nothing to parse' };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawOutput.trim());
  } catch (err) {
    return { valid: false, envelope: null, reason: `output is not valid JSON: ${err.message}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, envelope: null, reason: 'parsed output is not a JSON object' };
  }

  if (typeof parsed.answer !== 'string' || parsed.answer.trim().length === 0) {
    return { valid: false, envelope: null, reason: 'envelope is missing a non-empty "answer" string' };
  }

  if (!Array.isArray(parsed.claims)) {
    return { valid: false, envelope: null, reason: '"claims" is missing or not an array' };
  }

  const claims = [];
  for (let i = 0; i < parsed.claims.length; i += 1) {
    const raw = parsed.claims[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { valid: false, envelope: null, reason: `claims[${i}] is not an object` };
    }

    for (const field of REQUIRED_CLAIM_FIELDS) {
      if (raw[field] === null || raw[field] === undefined) {
        return { valid: false, envelope: null, reason: `claims[${i}] is missing required field "${field}"` };
      }
    }

    if (typeof raw.subject !== 'string' || raw.subject.trim().length === 0) {
      return { valid: false, envelope: null, reason: `claims[${i}].subject must be a non-empty string` };
    }
    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
      return { valid: false, envelope: null, reason: `claims[${i}].value must be a finite number` };
    }
    if (typeof raw.unit !== 'string' || raw.unit.trim().length === 0) {
      return { valid: false, envelope: null, reason: `claims[${i}].unit must be a non-empty string` };
    }
    if (raw.denominator !== undefined && raw.denominator !== null && (typeof raw.denominator !== 'number' || !Number.isFinite(raw.denominator))) {
      return { valid: false, envelope: null, reason: `claims[${i}].denominator must be a finite number or null` };
    }
    if (raw.qualifier !== undefined && raw.qualifier !== null && !ENVELOPE_QUALIFIERS.includes(raw.qualifier)) {
      return { valid: false, envelope: null, reason: `claims[${i}].qualifier must be one of ${ENVELOPE_QUALIFIERS.join('/')}/null` };
    }
    if (raw.confidence !== undefined && raw.confidence !== null && (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 1)) {
      return { valid: false, envelope: null, reason: `claims[${i}].confidence must be a number in [0, 1]` };
    }

    claims.push({
      subject: raw.subject.trim(),
      value: raw.value,
      unit: raw.unit.trim(),
      denominator: raw.denominator ?? null,
      basis: raw.basis ?? null,
      qualifier: raw.qualifier ?? null,
      confidence: typeof raw.confidence === 'number' ? raw.confidence : null
    });
  }

  return { valid: true, envelope: { answer: parsed.answer, claims }, reason: null };
}
