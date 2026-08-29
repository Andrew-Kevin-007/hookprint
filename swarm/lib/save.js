/**
 * BATON — swarm/lib/save.js
 *
 * Writes a pipeline result to disk as three plain-prose .md files — exactly
 * the model's text, nothing added. FRONTEND-SPEC.md's tamper surface is a
 * judge editing these files by hand as if they were a document, not a config
 * panel; adding a frontmatter block, a JSON wrapper, or even a leading
 * "# Researcher note" heading this file did not ask for would leak structure
 * the pipeline is specifically supposed to not have. See `pipeline.js` header
 * and `README.md` "Why the briefs are exactly the model's text".
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const HOP_FILENAMES = Object.freeze({
  hop1: 'hop-1-researcher.md',
  hop2: 'hop-2-summariser.md',
  hop3: 'hop-3-writer.md'
});

/**
 * @param {string} dir — directory to write into; created if missing.
 * @param {{ hop1: {text: string}, hop2: {text: string}, hop3: {text: string} }} result
 * @returns {{ hop1: string, hop2: string, hop3: string }} the three file paths written
 */
export function writeBriefs(dir, result) {
  mkdirSync(dir, { recursive: true });
  const paths = {};
  for (const key of ['hop1', 'hop2', 'hop3']) {
    const filePath = path.join(dir, HOP_FILENAMES[key]);
    // Exactly the model's text, trailing newline, nothing else — no
    // frontmatter, no JSON, no added heading. See file header.
    writeFileSync(filePath, `${result[key].text.trim()}\n`, 'utf8');
    paths[key] = filePath;
  }
  return paths;
}
