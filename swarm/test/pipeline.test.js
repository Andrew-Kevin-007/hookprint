/**
 * BATON — swarm/test/pipeline.test.js
 *
 * Offline tests for the swarm's plumbing: prompt chaining, scenario
 * selection, and file writing. NONE of this exercises the real Anthropic
 * API — `generate` is stubbed throughout, so these tests need no
 * ANTHROPIC_API_KEY, make no network call, and run in CI or any environment.
 * They prove the pipeline is wired correctly; they cannot and do not prove
 * anything about real model behavior or real corruption — that requires an
 * actual run against a live key (see README.md).
 *
 * Run: node --test test/*.test.js   (from swarm/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPipeline } from '../lib/pipeline.js';
import { researcherPrompt, summariserPrompt, writerPrompt, pickScenario, SCENARIOS } from '../lib/prompts.js';
import { writeBriefs, HOP_FILENAMES } from '../lib/save.js';
import { hasEnvCredential } from '../lib/client.js';

/** A stub `generate` that records every prompt it was called with and
 * returns a distinguishable canned reply per call, so chaining can be
 * verified without any real model call. */
function makeStubGenerate(replies) {
  const calls = [];
  let i = 0;
  const fn = async (prompt) => {
    calls.push(prompt);
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    return reply;
  };
  fn.calls = calls;
  return fn;
}

test('runPipeline calls generate exactly three times, in researcher -> summariser -> writer order', async () => {
  const generate = makeStubGenerate([
    'The researcher found that 4 of 50 sampled sessions abandoned checkout.',
    'A small sample showed a handful of checkout abandonments.',
    'A recent internal look at checkout found a modest amount of abandonment.'
  ]);

  const result = await runPipeline(generate, { scenario: SCENARIOS[0] });

  assert.equal(generate.calls.length, 3, 'expected exactly one call per hop');
  assert.equal(result.hop1.role, 'researcher');
  assert.equal(result.hop2.role, 'summariser');
  assert.equal(result.hop3.role, 'writer');
  assert.equal(result.hop1.text, 'The researcher found that 4 of 50 sampled sessions abandoned checkout.');
  assert.equal(result.hop2.text, 'A small sample showed a handful of checkout abandonments.');
  assert.equal(result.hop3.text, 'A recent internal look at checkout found a modest amount of abandonment.');
});

test('each hop\'s prompt actually carries the previous hop\'s text forward — the chain is real, not three independent calls', async () => {
  const hop1Text = 'UNIQUE_MARKER_HOP_ONE: 4 of 50 sessions abandoned.';
  const hop2Text = 'UNIQUE_MARKER_HOP_TWO: a handful abandoned.';
  const generate = makeStubGenerate([hop1Text, hop2Text, 'final paragraph']);

  await runPipeline(generate, { scenario: SCENARIOS[0] });

  const [researcherCall, summariserCall, writerCall] = generate.calls;
  assert.ok(researcherCall.includes(SCENARIOS[0]), 'researcher prompt should embed the chosen scenario');
  assert.ok(!researcherCall.includes('UNIQUE_MARKER'), 'researcher prompt should not already contain hop text (nothing to chain from yet)');
  assert.ok(summariserCall.includes(hop1Text), "summariser prompt must carry hop 1's full text forward");
  assert.ok(writerCall.includes(hop2Text), "writer prompt must carry hop 2's full text forward, not hop 1's");
  assert.ok(!writerCall.includes('UNIQUE_MARKER_HOP_ONE'), "writer must not see hop 1's raw text directly — only through hop 2");
});

test('no claim ID or identifier crosses a hop boundary — the prompts pass plain text only', () => {
  // A regression test for the one design decision everything follows from
  // (BUILD-PLAN.md "Do not align on the number... downstream carries no ID").
  // If someone later "helpfully" adds a claim_id/uuid to make re-identification
  // easier, this pipeline would stop being evidence for BATON's actual claim.
  const p1 = researcherPrompt(SCENARIOS[0]);
  const p2 = summariserPrompt('some researcher text');
  const p3 = writerPrompt('some summariser text');
  for (const [name, p] of [['researcher', p1], ['summariser', p2], ['writer', p3]]) {
    assert.ok(!/\bclaim[_-]?id\b/i.test(p), `${name} prompt must not mention a claim id`);
    assert.ok(!/\buuid\b/i.test(p), `${name} prompt must not mention a uuid`);
  }
});

test('summariser and writer prompts instruct genuine paraphrase and never mention introducing an error', () => {
  // This is the test that keeps this pipeline honest. If a future edit adds
  // language like "introduce an error" or "corrupt the number" to make the
  // demo more reliable, this test fails — that would turn BATON's central
  // claim ("we catch REAL corruption from REAL paraphrase, not scripted
  // mistakes") into exactly the theatre it says it is not.
  const forbidden = /\b(corrupt|introduce an error|make a mistake|get it wrong|change the number|drop the denominator|falsify)\b/i;

  const researcher = researcherPrompt(SCENARIOS[0]);
  const summariser = summariserPrompt('placeholder researcher text');
  const writer = writerPrompt('placeholder summariser text');

  assert.ok(!forbidden.test(researcher), 'researcher prompt must not instruct corruption');
  assert.ok(!forbidden.test(summariser), 'summariser prompt must not instruct corruption');
  assert.ok(!forbidden.test(writer), 'writer prompt must not instruct corruption');

  assert.match(summariser, /paraphrase|own words/i, 'summariser prompt should genuinely ask for paraphrase');
  assert.match(writer, /paraphrase|polish/i, 'writer prompt should genuinely ask for paraphrase/polish');
});

test('researcher prompt requires an explicit base/denominator, not a bare rate', () => {
  const p = researcherPrompt(SCENARIOS[0]);
  assert.match(p, /base explicitly|X of Y|out of M|denominator/i);
});

test('pickScenario is deterministic given a seeded rng, and always returns a listed scenario', () => {
  const fixed = () => 0; // always picks index 0
  assert.equal(pickScenario(fixed), SCENARIOS[0]);

  const nearOne = () => 0.9999999;
  assert.equal(pickScenario(nearOne), SCENARIOS[SCENARIOS.length - 1]);

  for (const s of SCENARIOS) {
    assert.equal(typeof s, 'string');
    assert.ok(s.length > 10);
  }
});

test('writeBriefs writes exactly the model text, no JSON wrapping, no added frontmatter', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'baton-swarm-test-'));
  try {
    const result = {
      hop1: { text: '  Researcher text with leading/trailing space.  \n' },
      hop2: { text: 'Summariser text.' },
      hop3: { text: 'Writer text.' }
    };
    const paths = writeBriefs(dir, result);

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, Object.values(HOP_FILENAMES).sort());

    const hop1Content = readFileSync(paths.hop1, 'utf8');
    assert.equal(hop1Content, 'Researcher text with leading/trailing space.\n', 'should trim, not wrap, the text');
    assert.ok(!hop1Content.startsWith('{'), 'must not be JSON');
    assert.ok(!hop1Content.startsWith('---'), 'must not carry frontmatter');
    assert.ok(!hop1Content.startsWith('#'), 'must not add a heading the model did not write');

    assert.equal(readFileSync(paths.hop2, 'utf8'), 'Summariser text.\n');
    assert.equal(readFileSync(paths.hop3, 'utf8'), 'Writer text.\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hasEnvCredential reflects ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN presence', () => {
  const savedKey = process.env.ANTHROPIC_API_KEY;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const savedRule = process.env.ANTHROPIC_FEDERATION_RULE_ID;
  const savedOrg = process.env.ANTHROPIC_ORGANIZATION_ID;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_FEDERATION_RULE_ID;
    delete process.env.ANTHROPIC_ORGANIZATION_ID;
    assert.equal(hasEnvCredential(), false);

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real';
    assert.equal(hasEnvCredential(), true);
  } finally {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    if (savedRule === undefined) delete process.env.ANTHROPIC_FEDERATION_RULE_ID;
    else process.env.ANTHROPIC_FEDERATION_RULE_ID = savedRule;
    if (savedOrg === undefined) delete process.env.ANTHROPIC_ORGANIZATION_ID;
    else process.env.ANTHROPIC_ORGANIZATION_ID = savedOrg;
  }
});
