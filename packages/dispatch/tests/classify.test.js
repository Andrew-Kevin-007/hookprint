import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyWorkload, classifyWithLLM, WORKLOAD_TYPES } from '../profiling/classify.js';

test('WORKLOAD_TYPES names the full taxonomy', () => {
  assert.deepEqual(WORKLOAD_TYPES, [
    'summarization', 'extraction', 'reasoning', 'synthesis',
    'multi_document_comparison', 'code_analysis'
  ]);
});

test('content with real code fences and language keywords classifies as code_analysis with non-trivial confidence', () => {
  const task = {
    kind: 'code-review',
    items: [
      {
        id: 'auth.js',
        content:
          '```js\nfunction authenticate(user) {\n  if (user.token) {\n    return validate(user.token);\n  }\n}\n```\n' +
          'class Session {\n  constructor(id) {\n    this.id = id;\n  }\n}\n'
      }
    ]
  };

  const result = classifyWorkload(task);

  assert.equal(result.workloadType, 'code_analysis');
  assert.equal(result.method, 'deterministic');
  assert.ok(result.confidence > 0.5, `expected non-trivial confidence, got ${result.confidence}`);
  assert.ok(result.signals.length >= 1);
  assert.equal(result.signals[0].workloadType, 'code_analysis');
  assert.ok(result.signals[0].evidence.length > 1, 'expected more than one code-analysis rule to fire');
});

test('explicit "compare X and Y" language across multiple items classifies as multi_document_comparison', () => {
  const task = {
    kind: 'vendor-analysis',
    qualityTargetReason: 'compare vendor A and vendor B and describe the difference between their pricing terms',
    items: [
      { id: 'vendor-a', content: 'Vendor A proposal.\nName: Acme Corp\nPrice: $100\nTerm: 12 months\n' },
      { id: 'vendor-b', content: 'Vendor B proposal.\nName: Globex Inc\nPrice: $150\nTerm: 24 months\n' }
    ]
  };

  const result = classifyWorkload(task);

  assert.equal(result.workloadType, 'multi_document_comparison');
  assert.equal(result.method, 'deterministic');
  assert.ok(result.confidence > 0.3);
});

test('multi_document_comparison never fires for a single-item task (comparison needs something to compare)', () => {
  const task = {
    kind: 'analysis',
    qualityTargetReason: 'compare this against nothing',
    items: [{ id: 'solo', content: 'compare versus contrast difference between things' }]
  };

  const result = classifyWorkload(task);
  assert.notEqual(result.workloadType, 'multi_document_comparison');
  assert.ok(!result.signals.some((s) => s.workloadType === 'multi_document_comparison'));
});

test('long, unstructured prose with no other strong signal falls back to summarization with LOW confidence', () => {
  const longProse = Array.from({ length: 60 }, (_, i) =>
    `Paragraph ${i}: the events of that day unfolded slowly across the valley, and nobody `
    + 'quite remembers who spoke first or what was said, only that the light was fading.'
  ).join(' ');

  const task = {
    kind: 'document-analysis',
    items: [{ id: 'doc', content: longProse }]
  };

  const result = classifyWorkload(task);

  assert.equal(result.workloadType, 'summarization');
  assert.ok(result.confidence < 0.35, `expected low confidence, got ${result.confidence}`);
  assert.ok(result.method === 'fallback' || (result.method === 'deterministic' && result.confidence < 0.35));
});

test('a task with genuinely no content and no items produces the honest zero-signal fallback shape', () => {
  const result = classifyWorkload({ kind: 'unknown', items: [] });

  assert.equal(result.workloadType, 'summarization');
  assert.equal(result.method, 'fallback');
  assert.equal(result.fallbackReason, 'no_deterministic_signal');
  assert.deepEqual(result.signals, []);
  assert.ok(result.confidence > 0 && result.confidence < 0.3);
});

test('signals[] contains more than just the winning class when multiple things genuinely fire', () => {
  // Deliberately ambiguous: real code fences/keywords AND an explicit
  // "summarize" instruction in the same content.
  const task = {
    kind: 'mixed',
    items: [
      {
        id: 'snippet',
        content:
          'Please summarize this: ```js\nfunction total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n```\n' +
          'class Cart { constructor() { this.items = []; } }'
      }
    ]
  };

  const result = classifyWorkload(task);

  assert.ok(result.signals.length > 1, 'expected more than one signal to fire for an ambiguous input');
  const workloadTypesSeen = new Set(result.signals.map((s) => s.workloadType));
  assert.ok(workloadTypesSeen.size > 1, 'expected signals to span more than one workload class');
  // The winning class must be the highest-scoring signal.
  const maxScore = Math.max(...result.signals.map((s) => s.score));
  assert.equal(result.signals[0].score, maxScore);
});

test('two classes scoring comparably close lowers the returned confidence rather than forcing false precision', () => {
  // Construct near-tied evidence for reasoning vs. extraction: logical
  // connectives plus an explicit extraction ask, both in a single short item.
  const task = {
    kind: 'analysis',
    qualityTargetReason: 'extract all the reasons',
    items: [
      {
        id: 'r',
        content: 'If the sensor fails, then the alarm triggers, therefore the operator is notified because of the fault.'
      }
    ]
  };

  const result = classifyWorkload(task);
  if (result.signals.length > 1) {
    const [first, second] = result.signals;
    if (first.score - second.score < 0.12) {
      assert.ok(result.confidence < first.score, 'expected ambiguity to lower confidence below the raw winning score');
    }
  }
  // Regardless of which branch fired, confidence must never exceed 1 and never be fabricated as exactly the raw score plus bonus.
  assert.ok(result.confidence <= 1 && result.confidence >= 0);
});

test('extraction fires on explicit instruction language plus structured key-value content', () => {
  const task = {
    kind: 'contact-mining',
    qualityTargetReason: 'extract all the email addresses from this list',
    items: [
      {
        id: 'contacts',
        content:
          'Name: John Doe\nEmail: john@example.com\nPhone: 555-0100\n' +
          'Name: Jane Roe\nEmail: jane@example.com\nPhone: 555-0101\n' +
          'Name: Sam Lee\nEmail: sam@example.com\nPhone: 555-0102\n'
      }
    ]
  };

  const result = classifyWorkload(task);
  assert.equal(result.workloadType, 'extraction');
  assert.equal(result.method, 'deterministic');
});

test('reasoning fires on conditional/causal density and inference-seeking question form, typically few items', () => {
  const task = {
    kind: 'analysis',
    items: [
      {
        id: 'q',
        content:
          'Why does the pipeline stall under load? If the queue backs up, then latency increases, ' +
          'therefore throughput drops because workers are blocked waiting. How should we redesign it?'
      }
    ]
  };

  const result = classifyWorkload(task);
  assert.equal(result.workloadType, 'reasoning');
});

test('synthesis fires on explicit combination language across multiple items feeding one unified output', () => {
  const task = {
    kind: 'report',
    qualityTargetReason: 'combine these into one unified report',
    items: [
      { id: 'a', content: 'Sales rose 10% in Q1.' },
      { id: 'b', content: 'Marketing spend increased 5% in Q1.' },
      { id: 'c', content: 'Customer churn fell slightly in Q1.' }
    ]
  };

  const result = classifyWorkload(task);
  assert.equal(result.workloadType, 'synthesis');
});

test('classifyWithLLM is a documented stub that always throws, never silently fabricating a model call', () => {
  assert.throws(() => classifyWithLLM({ items: [] }), /not implemented/i);
});
