/**
 * BATON — swarm/lib/prompts.js
 *
 * The three prompts, and nothing else that could be mistaken for scripted
 * corruption. Read these before touching pipeline.js:
 *
 *   - The researcher prompt asks for a quantified claim WITH its base stated
 *     explicitly ("X of Y ..."), because a claim with no base to begin with
 *     can't demonstrate denominator loss downstream.
 *   - The summariser and writer prompts each say "paraphrase" / "in your own
 *     words" / "do not copy sentences verbatim" — genuine condensation
 *     instructions. Neither prompt below the researcher's ever mentions an
 *     error, a number, a denominator, a caveat, or a mistake. If a claim
 *     drifts, drops its base, or loses a hedge, that happened because the
 *     model condensed it that way on its own — the documented, organic
 *     failure mode BUILD-PLAN.md and CONTENT-BRIEF.md cite — not because
 *     this file told it to.
 *   - Test `test/pipeline.test.js` asserts none of these prompts contain
 *     "corrupt", "error", "mistake", "wrong", or "drop" — see that test's
 *     comment for why it exists as a regression test, not a formality.
 */

/**
 * Scenario seeds for the researcher hop. Deliberately small, everyday,
 * harmless "someone ran a little internal study" situations — the same
 * shape as CONTENT-BRIEF.md's own example ("summarize findings from a small
 * internal study"). Rotating through several gives the pipeline a better
 * chance, across 5-10 runs, of landing on a document shape where a model
 * naturally condenses away a denominator or a hedge — that variance is the
 * point, not a defect to be pruned to one "reliable" scenario.
 */
export const SCENARIOS = [
  'a two-week trial of a simplified checkout flow, tested against a small sample of returning customers',
  'a pilot where a subset of incoming support tickets were triaged by a new auto-categorisation step before reaching a human agent',
  'an A/B test of a revised onboarding email sequence sent to a small batch of new sign-ups',
  'a short internal survey asking team members how often they actually used a new internal tool during its first month',
  'a limited rollout of a caching change to a subset of application servers, monitored for its effect on error rates',
  'a small usability study where a handful of new users were asked to complete one task using a redesigned settings page',
  'a trial of a revised code-review checklist applied to a sample of pull requests over one sprint',
  'a short study measuring how many flagged support emails were correctly triaged by a new filtering rule during its first week'
];

/**
 * Pick a scenario. `rng` defaults to `Math.random` but accepts an injected
 * generator so callers (and tests) can make the choice deterministic.
 */
export function pickScenario(rng = Math.random) {
  const i = Math.floor(rng() * SCENARIOS.length);
  return SCENARIOS[Math.min(i, SCENARIOS.length - 1)];
}

export function researcherPrompt(scenario) {
  return `You are a researcher on a small internal team. Write a short internal research note reporting the results of ${scenario}.

Write it as plain prose — the way a person would write an internal memo or research note. Do not use JSON, bullet-point data dumps, tables, or a labeled-fields format. Two to four short paragraphs is enough.

Report your central finding as a specific quantified claim, and state its full base explicitly — for example "X of Y sessions," "N out of M respondents," or an equivalent ratio. Do not report a bare rate or percentage with no denominator. Invent plausible, specific numbers appropriate to the scenario — you are not describing a real study. If the finding is based on a small sample or is otherwise preliminary, say so honestly in the note — do not overstate how confident the finding is.

Write only the note itself. No title, no signature, no metadata, no markdown formatting.`;
}

export function summariserPrompt(researcherText) {
  return `You are a colleague who just received the note below and needs to pass it on to someone busier than you. Write a short, condensed summary of it — two to four sentences — capturing the key facts.

Paraphrase in your own words. Do not copy sentences from the note verbatim, and do not quote it directly. Write it as plain prose, the way you'd summarize something in a quick email — no JSON, no bullet points, no labeled fields, no markdown formatting.

Write only the summary itself. No title, no signature, no metadata.

--- NOTE ---
${researcherText}`;
}

export function writerPrompt(summariserText) {
  return `You are preparing a short internal update for a wider audience, based on the summary below. Turn it into a single well-written paragraph suitable for a monthly team update or newsletter.

Paraphrase and polish — do not copy sentences from the summary verbatim. Write naturally, in plain prose. Do not use JSON, bullet points, headers, or markdown formatting. Do not add any new facts beyond what the summary tells you.

Write only the paragraph itself. No title, no signature, no metadata.

--- SUMMARY ---
${summariserText}`;
}
