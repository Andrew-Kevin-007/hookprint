/**
 * bench/degradation/campaign.js — the experiment design.
 *
 * Build plan §"Phase 3 — The measurement campaign": one fixed corpus, one
 * task, batch sizes swept across a range, every provider, repeated for
 * noise. This module owns the DESIGN — which (provider, batchSize,
 * repetition) cells exist and what content each one is handed — and does no
 * execution itself (that is runner.js's job).
 *
 * FIXED CORPUS CHOICE: `fixtures/real-corpus/` (raven-deep-trust.md,
 * zeus-confidence-routing.md — see that directory's MANIFEST.md), not a
 * synthetic corpus. Both files are real, already judge-verifiable prose (a
 * skeptical judge can diff them against the untouched originals in
 * `D:\Tenori_Hack\ideation\`), and at 271 paragraph-chunks total (measured,
 * see below) they comfortably cover every batch size in this sweep without
 * needing to synthesize anything. Chunking is by paragraph (blocks
 * separated by one or more blank lines) — the natural unit size in
 * markdown prose, avoiding both "one word" (too fine, meaningless at
 * batch-size 1) and "one whole file" (too coarse, no batch-size gradient
 * possible within a single file).
 *
 * EVERY CELL USES THE SAME TASK: for a given batchSize N, the batch content
 * is always the corpus's first N chunks (indices 0..N-1, in the fixed
 * paragraph order the corpus loader produces) — deterministic across every
 * provider and every repetition. This keeps the experiment a true "same
 * task, growing context" sweep: batch-size 8 for provider A is asked to
 * process the exact same 8 paragraphs as batch-size 8 for provider B, and
 * repetition 2 sends the identical content repetition 1 did (repetitions
 * exist to sample the PROVIDER's response noise at a fixed context load,
 * not to vary the input).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { MODEL_PROFILES } from '../../packages/dispatch/provider-profiles.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_CORPUS_DIR = join(HERE, '..', '..', 'fixtures', 'real-corpus');
const REAL_CORPUS_FILES = ['raven-deep-trust.md', 'zeus-confidence-routing.md'];

/**
 * The six real-execution providers registered in executor/index.js.
 * Deliberately excludes 'local' (provider-profiles.js's dev/test-only
 * profile — there is no "local" SDK to actually call).
 */
export const PROVIDERS = ['anthropic', 'openai', 'groq', 'cerebras', 'gemini', 'openrouter'];

/**
 * Batch sizes swept, doubling from 1. Capped at **16**, not the 32 a naive
 * doubling range might suggest, for a specific, checked reason: reading
 * `MODEL_PROFILES` in provider-profiles.js, `maxBatchSize` per provider is
 * { anthropic: 35, openai: 30, groq: 32, cerebras: **16**, gemini: 60,
 * openrouter: 40 } — cerebras's ceiling is the tightest of all six, at 16.
 * A batch size of 32 would be a valid cell for five providers and an
 * OUT-OF-CONTRACT cell for cerebras (exceeding its own documented safe
 * ceiling) — the task brief explicitly asks not to do that silently. Rather
 * than special-case one provider (skip it for that cell, or clamp its
 * batch size down while every other provider's cell uses the nominal
 * value, which would quietly make it a different experiment), the sweep
 * itself stops at 16: every (provider, batchSize) cell in
 * `buildCampaignPlan()`'s output is then valid for *every* provider,
 * uniformly, with no per-provider exception anywhere in this file.
 * `validateBatchSizesAgainstProviderCeilings()` below checks this claim at
 * runtime rather than leaving it as an unverified comment.
 */
export const BATCH_SIZES = [1, 2, 4, 8, 16];

/**
 * Repeated 3x per cell for noise. Justification: this is real, live model
 * output — even at a fixed context load, a single sample cannot distinguish
 * "this provider genuinely degrades here" from "this one response happened
 * to be bad." 3 is the smallest n that lets `analyze.js` report a real
 * stddev (n=1 has none, n=2's stddev is barely informative) while staying
 * inside what free-tier quotas can plausibly afford across a 6-provider x
 * 5-batch-size sweep: 6 x 5 x 3 = 90 cells total, and cerebras alone (the
 * tightest quota: 5 RPM per provider-profiles.js) already costs ~90 seconds
 * of pacing for its 15 cells before a single retry. A higher repetition
 * count would buy a better noise estimate at a real, measured wall-clock
 * cost this project cannot currently afford; 3 is the documented trade-off,
 * not an arbitrary default.
 */
export const REPETITIONS_PER_CELL = 3;

/** Split raw markdown text into paragraph-level chunks: one or more blank
 * lines is a paragraph boundary. Deliberately the simplest thing that
 * produces a stable, meaningful unit size for this corpus — no markdown
 * parser, no heading-awareness, just blank-line splitting. */
function splitIntoParagraphs(text) {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Load the fixed corpus as an ordered array of `{ id, content }` chunks —
 * the same item shape `route-contracts.js`'s `buildTaskRequest()` and
 * `executor/index.js`'s `executeBatch()` already expect. Order is fixed:
 * every paragraph of `raven-deep-trust.md` (in file order), then every
 * paragraph of `zeus-confidence-routing.md` (in file order) — 271 chunks
 * total, measured directly against the committed fixture files, comfortably
 * above the largest batch size (16) this campaign sweeps.
 *
 * @param {{ corpusDir?: string, files?: string[] }} [opts]
 * @returns {Array<{ id: string, content: string }>}
 */
export function loadRealCorpusChunks(opts = {}) {
  const { corpusDir = REAL_CORPUS_DIR, files = REAL_CORPUS_FILES } = opts;
  const chunks = [];
  for (const file of files) {
    const filePath = join(corpusDir, file);
    const text = readFileSync(filePath, 'utf8');
    const paragraphs = splitIntoParagraphs(text);
    const stem = basename(file, '.md');
    paragraphs.forEach((content, idx) => {
      chunks.push({ id: `${stem}-p${idx}`, content });
    });
  }
  return chunks;
}

/**
 * Verify that every batch size in `batchSizes` is at or below EVERY
 * provider's own `maxBatchSize` ceiling (provider-profiles.js
 * `MODEL_PROFILES`). This is the runtime check backing the doc comment on
 * `BATCH_SIZES` above — a later edit to either constant that violates the
 * "uniform across every provider" invariant fails loudly here rather than
 * silently producing an out-of-contract cell for whichever provider has the
 * tightest ceiling.
 *
 * @param {number[]} [batchSizes]
 * @param {string[]} [providers]
 * @returns {{ ok: boolean, violations: Array<{ provider: string, maxBatchSize: number, batchSize: number }> }}
 */
export function validateBatchSizesAgainstProviderCeilings(batchSizes = BATCH_SIZES, providers = PROVIDERS) {
  const violations = [];
  for (const providerName of providers) {
    const profile = MODEL_PROFILES[providerName];
    const ceiling = profile?.maxBatchSize;
    if (!Number.isFinite(ceiling)) continue;
    for (const batchSize of batchSizes) {
      if (batchSize > ceiling) {
        violations.push({ provider: providerName, maxBatchSize: ceiling, batchSize });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Enumerate every (provider, batchSize, repetition) cell — the full
 * campaign plan. Deterministic and enumerable: calling this twice with the
 * same arguments produces byte-identical plans, which is what lets
 * `runner.js`'s resumability check key off a deterministic `taskId` alone.
 *
 * @param {Array<{ id: string, content: string }>} corpus
 * @param {number[]} [batchSizes]
 * @param {string[]} [providers]
 * @param {number} [repetitions]
 * @returns {Array<{ provider: string, batchSize: number, repetition: number, taskId: string, batchContent: Array<{id:string, content:string}> }>}
 */
export function buildCampaignPlan(corpus, batchSizes = BATCH_SIZES, providers = PROVIDERS, repetitions = REPETITIONS_PER_CELL) {
  const items = Array.isArray(corpus) ? corpus : [];
  const cells = [];

  for (const provider of providers) {
    for (const batchSize of batchSizes) {
      const batchContent = items.slice(0, Math.min(batchSize, items.length));
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        cells.push({
          provider,
          batchSize,
          repetition,
          // Deterministic id: doubles as the resumability key in
          // runner.js (readEvents' own taskId filter, no bespoke matching).
          taskId: `campaign-${provider}-bs${batchSize}-r${repetition}`,
          batchContent
        });
      }
    }
  }

  return cells;
}
