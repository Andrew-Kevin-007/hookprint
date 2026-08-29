/**
 * classify.js — deterministic workload-type classification for a task.
 *
 * Owns: closing the gap the project plan calls out explicitly — before this
 * module existed, `analyzeTaskQuality()` inferred everything from item COUNT
 * plus exactly two hardcoded string checks on `task.kind`. There was no real
 * taxonomy anywhere in this codebase. This module is that taxonomy.
 *
 * ---------------------------------------------------------------------------
 * STYLE NOTE (matches `packages/align/quantity.js`'s `pickPrimary()` idiom):
 * every workload class below is decided by a small ORDERED RULE CASCADE, not
 * a single keyword match. Each detector inspects several independent signals
 * (explicit language, structural shape, density) and accumulates a score with
 * evidence attached, so a verdict is always auditable — "why did this task
 * classify as code_analysis" has a real answer, not a black box.
 *
 * FALLBACK DISCIPLINE: classification never calls a model. When the
 * deterministic cascade produces no confident signal at all, `classifyWorkload`
 * returns a low-confidence 'summarization' result and documents why — it does
 * NOT quietly guess with false precision. `classifyWithLLM` is the named,
 * unimplemented plug-in point for a future last-resort LLM classifier; it
 * throws rather than pretending to call a model that isn't wired up in this
 * environment.
 */

/** The full workload taxonomy this project reasons about. */
export const WORKLOAD_TYPES = Object.freeze([
  'summarization', 'extraction', 'reasoning', 'synthesis',
  'multi_document_comparison', 'code_analysis'
]);

/**
 * How close the top two candidate scores must be to count as "comparably
 * close" — at or under this margin, `classifyWorkload` deliberately lowers
 * its returned confidence rather than forcing false precision on a coin
 * flip between two plausible classes.
 */
const AMBIGUITY_MARGIN = 0.12;

/**
 * The floor a winning signal's raw score must clear to count as a real
 * deterministic verdict. Below this, the cascade found *something* but not
 * enough to trust, so `classifyWorkload` reports it honestly as a fallback
 * rather than dressing up a weak signal as a confident one.
 */
const FALLBACK_FLOOR = 0.3;

/** Fixed, documented confidence used when literally nothing fired. */
const NO_SIGNAL_CONFIDENCE = 0.15;

/**
 * Classify one task's workload type from information already on the task —
 * no network call, no LLM, matching this project's deterministic-first ethos.
 *
 * @param {object} task  A route-contracts.js task (or anything item-shaped:
 *                        `{ items: [{ id, content }], kind, qualityTargetReason }`).
 * @returns {{ workloadType: string, confidence: number, signals: object[],
 *             method: 'deterministic'|'fallback', fallbackReason?: string }}
 */
export function classifyWorkload(task) {
  const items = Array.isArray(task?.items) ? task.items : [];
  const contents = items.map((item) => String(item?.content ?? ''));
  const itemCount = items.length;
  const metadataText = [task?.kind, task?.qualityTargetReason].filter(Boolean).join(' ');

  const detectors = [
    detectCodeAnalysis(items, contents),
    detectMultiDocumentComparison(contents, metadataText),
    detectExtraction(contents, metadataText),
    detectReasoning(contents, itemCount),
    detectSynthesis(contents, metadataText, itemCount),
    detectSummarization(contents)
  ].filter(Boolean);

  if (detectors.length === 0) {
    return {
      workloadType: 'summarization',
      confidence: NO_SIGNAL_CONFIDENCE,
      signals: [],
      method: 'fallback',
      fallbackReason: 'no_deterministic_signal'
    };
  }

  const ranked = [...detectors].sort((a, b) => b.score - a.score);
  const winner = ranked[0];
  const runnerUp = ranked[1] ?? null;
  const signals = ranked.map(toSignalRecord);

  let confidence = winner.score;
  const ambiguous = runnerUp !== null && (winner.score - runnerUp.score) < AMBIGUITY_MARGIN;
  if (ambiguous) {
    // Two (or more) classes scored comparably close: this is not a confident
    // call, and reporting it as one would be false precision.
    confidence = Math.max(0.1, confidence - 0.25);
  }
  confidence = clamp01(confidence);

  if (winner.score < FALLBACK_FLOOR) {
    // Something fired, but not enough to trust as a real deterministic
    // verdict — report honestly as a fallback while still surfacing what
    // was seen, for auditability and for a future pass to improve on.
    return {
      workloadType: 'summarization',
      confidence,
      signals,
      method: 'fallback',
      fallbackReason: 'no_deterministic_signal'
    };
  }

  return {
    workloadType: winner.workloadType,
    confidence,
    signals,
    method: 'deterministic'
  };
}

/**
 * Last-resort LLM-based classifier — NOT IMPLEMENTED in this pass.
 *
 * `classifyWorkload()` never calls this itself; it is the named, documented
 * plug-in point a later phase wires up once provider credentials exist in
 * this environment (per the project plan's Phase 5: "the free-tier LLM as a
 * fallback classifier only"). Calling it now throws rather than silently
 * returning a fabricated answer, so nothing ever pretends a model was
 * consulted when it wasn't.
 *
 * @param {object} _task
 * @throws {Error} always, in this pass
 */
export function classifyWithLLM(_task) {
  throw new Error(
    'classifyWithLLM() is not implemented: it requires live provider credentials, ' +
    'which do not exist in this environment. classifyWorkload() falls back to a ' +
    "low-confidence deterministic 'summarization' result instead of calling this."
  );
}

/* -------------------------------------------------------------------------- */
/* Detectors — one ordered rule cascade per workload class                    */
/* -------------------------------------------------------------------------- */

/**
 * code_analysis: fenced code blocks, language-keyword density, brace/
 * semicolon density, indentation patterns, and file-extension-like tokens.
 * Each rule is independent evidence; none alone is treated as proof.
 */
function detectCodeAnalysis(items, contents) {
  const combined = contents.join('\n');
  if (combined.length === 0) return null;

  const evidence = [];
  let score = 0;

  // Rule 1: fenced code blocks are the strongest single signal available.
  const fenceMarks = combined.match(/```/g);
  const fenceCount = fenceMarks ? Math.floor(fenceMarks.length / 2) : 0;
  if (fenceCount > 0) {
    evidence.push(`${fenceCount} fenced code block(s)`);
    score += 0.45;
  }

  // Rule 2: common language keyword/syntax density (function/class/import/def/…).
  const keywordHits = (combined.match(
    /\b(function|class|import|export|def|const|let|var|public|private|static|void|return|package|struct|interface|namespace)\b/g
  ) || []).length;
  const wordCount = Math.max(1, combined.split(/\s+/).length);
  const keywordDensity = keywordHits / wordCount;
  if (keywordHits >= 2 && keywordDensity > 0.02) {
    evidence.push(`keyword density ${(keywordDensity * 100).toFixed(1)}% (${keywordHits} hits)`);
    score += Math.min(0.35, keywordDensity * 6);
  }

  // Rule 3: brace/semicolon-to-text ratio — prose rarely leans on `{};` this hard.
  const braceCount = (combined.match(/[{};]/g) || []).length;
  const braceRatio = braceCount / combined.length;
  if (braceRatio > 0.01) {
    evidence.push(`brace/semicolon ratio ${(braceRatio * 100).toFixed(2)}%`);
    score += Math.min(0.25, braceRatio * 10);
  }

  // Rule 4: consistent leading-whitespace indentation across multiple lines.
  const lines = combined.split('\n');
  const indentedLines = lines.filter((line) => /^(\s{2,}|\t)\S/.test(line)).length;
  const indentRatio = lines.length > 1 ? indentedLines / lines.length : 0;
  if (indentRatio > 0.15) {
    evidence.push(`${indentedLines}/${lines.length} lines indented`);
    score += Math.min(0.2, indentRatio * 0.4);
  }

  // Rule 5: file-extension-like tokens in item ids or content (foo.py, index.ts).
  const extRe = /\b[\w-]+\.(js|jsx|ts|tsx|py|java|go|rb|cpp|cc|c|h|hpp|cs|rs|php|kt|swift|scala|sh|json|yaml|yml)\b/i;
  const hasExtToken = items.some(
    (item) => extRe.test(String(item?.id ?? '')) || extRe.test(String(item?.content ?? ''))
  );
  if (hasExtToken) {
    evidence.push('file-extension-like token present');
    score += 0.2;
  }

  if (evidence.length === 0) return null;
  return { workloadType: 'code_analysis', score: Math.min(1, score), evidence };
}

/**
 * multi_document_comparison: requires more than one item (a hard structural
 * gate — comparison needs something to compare), then looks for explicit
 * comparison language, similar-length clustering, and repeated header/field
 * names across items.
 */
function detectMultiDocumentComparison(contents, metadataText) {
  if (contents.length <= 1) return null;

  const evidence = [];
  let score = 0;
  const combined = `${metadataText} ${contents.join(' ')}`;

  // Rule 1: explicit comparison language ("compare", "versus", "difference between").
  if (/\b(compare|comparison|versus|vs\.?|difference between|differences? in|contrast(?:ing)?|relative to)\b/i.test(combined)) {
    evidence.push('explicit comparison language');
    score += 0.45;
  }

  // Rule 2: structural similarity — comparable items tend to cluster in length.
  const lengths = contents.map((c) => c.length).filter((n) => n > 0);
  if (lengths.length >= 2) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
    const coefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : 1;
    if (coefficientOfVariation < 0.35) {
      evidence.push(`similar item lengths (CV ${coefficientOfVariation.toFixed(2)})`);
      score += 0.2;
    }
  }

  // Rule 3: repeated header/field names across items ("## Overview", "Name:").
  const headerRe = /^(#{1,6}\s*.+|[\w \-]{2,40}:)\s*$/gm;
  const headerSets = contents.map(
    (c) => new Set((c.match(headerRe) || []).map((h) => h.trim().toLowerCase()))
  );
  const nonEmptySets = headerSets.filter((set) => set.size > 0);
  if (nonEmptySets.length >= 2) {
    const [first, ...rest] = nonEmptySets;
    const overlaps = rest.some((set) => [...set].some((h) => first.has(h)));
    if (overlaps) {
      evidence.push('repeated header/field names across items');
      score += 0.2;
    }
  }

  if (evidence.length === 0) return null;
  return { workloadType: 'multi_document_comparison', score: Math.min(1, score), evidence };
}

/**
 * extraction: explicit extraction instruction language, structured-looking
 * source content (tables, key-value/form patterns), or long dense content
 * paired with a narrow stated ask.
 */
function detectExtraction(contents, metadataText) {
  const evidence = [];
  let score = 0;
  const combined = contents.join(' ');

  // Rule 1: explicit extraction instruction language.
  const extractRe = /\b(extract|find all|list all|pull out|identify all|enumerate)\b/i;
  if (extractRe.test(metadataText) || extractRe.test(combined)) {
    evidence.push('explicit extraction instruction language');
    score += 0.45;
  }

  // Rule 2: markdown-table-like rows in the source.
  const tableRows = (combined.match(/^\s*\|.+\|\s*$/gm) || []).length;
  if (tableRows >= 2) {
    evidence.push(`${tableRows} table-like row(s)`);
    score += 0.25;
  }

  // Rule 3: key-value line density (forms, structured records: "Field: value").
  const kvLines = (combined.match(/^[\w \-]{2,40}:\s*\S.*$/gm) || []).length;
  const totalLines = Math.max(1, combined.split('\n').length);
  const kvDensity = kvLines / totalLines;
  if (kvLines >= 3 && kvDensity > 0.2) {
    evidence.push(`key-value line density ${(kvDensity * 100).toFixed(0)}% (${kvLines} lines)`);
    score += 0.25;
  }

  // Rule 4: long/dense source content paired with a narrow stated ask.
  const narrowAskRe = /\b(extract|find|list|pull out|identify|what is|how many)\b/i;
  if (combined.length > 1500 && narrowAskRe.test(metadataText)) {
    evidence.push('long source content paired with a narrow stated ask');
    score += 0.2;
  }

  if (evidence.length === 0) return null;
  return { workloadType: 'extraction', score: Math.min(1, score), evidence };
}

/**
 * reasoning: conditional/causal connective density, multi-step markers, and
 * inference-seeking question forms ("why"/"how") as opposed to lookup forms
 * ("what is"/"when"). Typically single- or few-item tasks.
 */
function detectReasoning(contents, itemCount) {
  const evidence = [];
  let score = 0;
  const combined = contents.join(' ');
  const wordCount = Math.max(1, combined.split(/\s+/).length);

  // Rule 1: conditional/causal connective density ("if", "therefore", "because"…).
  const logicHits = (combined.match(
    /\b(if|then|therefore|because|thus|hence|implies|consequently|so that|given that)\b/gi
  ) || []).length;
  const logicDensity = logicHits / wordCount;
  if (logicHits >= 2 && logicDensity > 0.015) {
    evidence.push(`logical-connective density ${(logicDensity * 100).toFixed(1)}% (${logicHits} hits)`);
    score += Math.min(0.4, logicDensity * 15);
  }

  // Rule 2: multi-step reasoning markers.
  if (/\b(step\s*\d|first,|second,|third,|next,|finally,)\b/i.test(combined)) {
    evidence.push('multi-step reasoning markers');
    score += 0.2;
  }

  // Rule 3: inference-seeking question form ("why"/"how"), not a lookup form
  // ("what is"/"when did"/"who is") — those name extraction, not reasoning.
  const inferenceQ = /\b(why|how)\b[^?]{0,120}\?/i.test(combined);
  const lookupQ = /\b(what is|when (?:did|was|is)|who (?:is|was))\b[^?]{0,80}\?/i.test(combined);
  if (inferenceQ && !lookupQ) {
    evidence.push('inference-seeking question form (why/how)');
    score += 0.25;
  }

  // Rule 4: reasoning workloads are typically single- or few-item asks — only
  // counts as corroborating evidence once something else has already fired.
  if (score > 0 && itemCount <= 2) {
    evidence.push(`few-item task (itemCount=${itemCount}) consistent with focused reasoning`);
    score += 0.15;
  }

  if (evidence.length === 0) return null;
  return { workloadType: 'reasoning', score: Math.min(1, score), evidence };
}

/**
 * synthesis: explicit synthesis/combination language, or structurally several
 * items feeding one task where the ask implies a single unified narrative
 * output rather than one answer per item.
 */
function detectSynthesis(contents, metadataText, itemCount) {
  const evidence = [];
  let score = 0;
  const combined = `${metadataText} ${contents.join(' ')}`;

  // Rule 1: explicit synthesis/combination language.
  if (/\b(synthesize|synthesis|combine|merge|unify|consolidate|integrate)\b/i.test(combined)) {
    evidence.push('explicit synthesis/combination language');
    score += 0.45;
  }

  // Rule 2: language implying one unified narrative output ("a single report",
  // "one combined answer") rather than per-item output.
  if (/\b(unified|single (?:report|narrative|summary)|one (?:coherent|combined) (?:answer|report|document))\b/i.test(combined)) {
    evidence.push('language implying one unified narrative output');
    score += 0.25;
  }

  // Structural corroboration only — several items alone is not synthesis
  // evidence (it would then also fire for comparison), so it only counts once
  // one of the language rules above has already fired.
  if (evidence.length > 0 && itemCount > 1) {
    evidence.push(`${itemCount} items feeding a single task`);
    score += 0.15;
  }

  if (evidence.length === 0) return null;
  return { workloadType: 'synthesis', score: Math.min(1, score), evidence };
}

/**
 * summarization: the DEFAULT / lowest-confidence bucket. Fires on explicit
 * summarization language, or on long content with no other stated narrow ask
 * — deliberately the weakest, most generic rule in the whole cascade, because
 * this is the honest catch-all rather than a class every task cleanly fits.
 */
function detectSummarization(contents) {
  const evidence = [];
  let score = 0;
  const combined = contents.join(' ');

  // Rule 1: explicit summarization language.
  if (/\b(summarize|summarise|summary|tl;dr|recap|overview|condense)\b/i.test(combined)) {
    evidence.push('explicit summarization language');
    score += 0.4;
  }

  // Rule 2: long content, implied short output — the generic "gist" shape.
  if (combined.length > 800) {
    evidence.push('long content, implied short output');
    score += 0.2;
  }

  if (evidence.length === 0) return null;
  return { workloadType: 'summarization', score: Math.min(1, score), evidence };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function toSignalRecord(detected) {
  return {
    workloadType: detected.workloadType,
    score: Number(detected.score.toFixed(3)),
    evidence: detected.evidence
  };
}

function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x.toFixed(3))));
}
