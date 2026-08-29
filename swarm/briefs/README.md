# `briefs/` — empty, pending a live pipeline run

This directory is where the primary live-demo tamper surface goes:
`hop-1-researcher.md`, `hop-2-summariser.md`, `hop-3-writer.md` — the raw
prose output of one chosen run of `../run.js`, picked by hand for showing
genuine organic corruption (see `../README.md` "Workflow: from a generated
run to a demo fixture").

It is empty because no `ANTHROPIC_API_KEY` (or other Anthropic credential)
was available in the environment this package was built in — see
`../README.md` "Status in this environment" for exactly what was checked.
The pipeline itself is fully built and offline-tested (`npm test`, 9/9
passing); it has just never made a real model call.

**Until this directory is populated, the primary demo fixture is
`../../fixtures/real-corpus/`** — real, historical, pre-existing evidence
that needs no key and nothing generated. See its `MANIFEST.md`.

Delete this file once `briefs/` holds real hop files.
