/**
 * BATON — swarm/lib/pipeline.js
 *
 * The 3-hop chain: researcher -> summariser -> writer. This module owns hop
 * sequencing only. It takes a `generate` function as a parameter rather than
 * importing the Anthropic client directly, so the plumbing — prompt
 * construction, hop chaining, the shape of the result — can be exercised
 * offline in tests with a stub `generate`, with no network call and no key
 * (see test/pipeline.test.js). run.js is the only caller that passes the
 * real SDK-backed generate() from lib/client.js.
 *
 * No claim ID crosses a hop boundary here, by design — each hop only ever
 * receives the previous hop's plain-text output, exactly like a real
 * researcher/summariser/writer handoff. That is what makes a corrupted run
 * of this pipeline honest evidence for BATON's re-identification claim
 * rather than a checksum exercise wearing a disguise.
 */

import { researcherPrompt, summariserPrompt, writerPrompt, pickScenario } from './prompts.js';

/**
 * @param {(prompt: string) => Promise<string>} generate
 *   Takes one user-turn prompt, returns the model's plain-text reply. This
 *   is the entire seam between this module and whatever is doing the actual
 *   generation.
 * @param {{ scenario?: string, rng?: () => number }} [options]
 *   `scenario` forces a specific scenario instead of picking one; `rng` is
 *   forwarded to pickScenario() when `scenario` is omitted.
 * @returns {Promise<{
 *   scenario: string,
 *   hop1: { role: 'researcher', text: string },
 *   hop2: { role: 'summariser', text: string },
 *   hop3: { role: 'writer', text: string }
 * }>}
 */
export async function runPipeline(generate, options = {}) {
  const scenario = options.scenario ?? pickScenario(options.rng);

  const hop1 = await generate(researcherPrompt(scenario));
  const hop2 = await generate(summariserPrompt(hop1));
  const hop3 = await generate(writerPrompt(hop2));

  return {
    scenario,
    hop1: { role: 'researcher', text: hop1 },
    hop2: { role: 'summariser', text: hop2 },
    hop3: { role: 'writer', text: hop3 }
  };
}
