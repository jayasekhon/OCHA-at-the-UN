# OCHA at the UN

A static dashboard of OCHA's footprint across UN meetings — press briefings,
leadership statements, Security Council mentions, and which member states
reference OCHA — built on the [UN Transcripts](https://transcripts.un.org)
API. Runs entirely on GitHub Pages; a scheduled GitHub Action does the data
fetching, so there's no server to host or pay for.

## How it works

```
.github/workflows/refresh-data.yml   →  runs on a schedule (and on demand)
scripts/ingest.js                    →  calls transcripts.un.org, writes...
data/crises.json                     →  ...which index.html fetches at load time
index.html                           →  the dashboard itself (map, quote band, tabs)
```

No backend, no database, no CORS — `index.html` just does
`fetch('./data/crises.json')`, same-origin, because Pages serves it as a
plain static file that the Action keeps refreshed by committing to the repo.

## Setup

1. **Create the repo** and push everything in this folder to it (`main`
   branch, files at the repo root — `index.html` needs to be at the root or
   in `/docs` depending on how you configure Pages below).

2. **Enable Pages**: repo Settings → Pages → Source: "Deploy from a branch" →
   Branch: `main`, folder `/ (root)`.

3. **Allow the workflow to commit**: repo Settings → Actions → General →
   Workflow permissions → select "Read and write permissions". Without this,
   the scheduled Action can run the ingestion but won't be able to push the
   updated `data/crises.json` back.

4. **Run it once manually**: Actions tab → "Refresh UN Transcripts data" →
   Run workflow. Check the run log — this is also your first real test of
   whether the search endpoint's response shape matches what `ingest.js`
   expects (see the note below).

5. Your site is live at `https://<your-username>.github.io/<repo-name>/`.
   It'll keep itself updated every 6 hours from then on (edit the cron
   schedule in the workflow file to change that).

## Before you trust the data — verify the search response shape

I built the `?ft=1` full-text search integration in `scripts/ingest.js` from
the documented behavior in
[`llms.txt`](https://transcripts.un.org/llms.txt), not from a response I
directly inspected — my own environment couldn't execute that specific
request to check. Run this once and compare the real field names against
`normalizeMatch()` in `scripts/ingest.js` (currently assumes `speaker`,
`text`/`snippet`, `start`, `pageUrl`, and a top-level `items` list):

```bash
curl "https://transcripts.un.org/en/meetings.json?q=OCHA&ft=1&from=2026-08-01" | jq .
```

The [OpenAPI spec](https://transcripts.un.org/openapi.json) is the ground
truth if anything doesn't match. The first manual workflow run (step 4 above)
will also surface this immediately — if the field names are wrong, you'll see
0 statements come back for every crisis in the Action log even though the
requests succeed.

## What's tracked, and what's deliberately not automated

- **Tracked crises** live in `TRACKED_CRISES` at the top of
  `scripts/ingest.js` — add, remove, or reweight countries there.
- **No "supportive / neutral / critical" stance** on the Member States on
  OCHA section. Classifying diplomatic language as critical of your own
  agency is an editorial judgment, not something to silently automate in a
  reputational-tracking tool — add it deliberately (human-reviewed, or a
  clearly-labeled AI pass with review) rather than guessing.
- **No text summarization.** Real statements can run long — the dashboard
  shows the raw matched text as-is. If that reads poorly in the compact card
  layout in practice, add a summarization step in `ingest.js`, and keep the
  raw text + video link alongside any summary for traceability.

## Local development

```bash
node scripts/ingest.js     # writes data/crises.json (needs real network access)
python3 -m http.server      # or any static server, then open index.html
```

`data/crises.json` ships pre-seeded with sample data (`generatedAt: null`) so
the page renders something reasonable before the first real Actions run
completes — the dashboard shows a "SEED DATA" badge until then.
