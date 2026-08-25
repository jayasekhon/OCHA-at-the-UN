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

## Diagnosing the data pipeline

`scripts/ingest.js`'s field-name assumptions (`normalizeMatch()`,
`extractItems()`, `extractStatements()`) have been verified against a live
response, and are documented in the comment block at the top of the file. If
the UN Transcripts API's response shape ever changes and every query starts
coming back empty, `ingest.js` fails loudly rather than silently committing
an empty-but-"successful" dataset: it exits non-zero and prints an
`[ingest][warn]` block with the real top-level keys and a raw JSON sample.
You can also force a full raw dump on every run via the `debug_shape` input
on the "Refresh UN Transcripts data" workflow (Actions tab → Run workflow),
or locally with `INGEST_DEBUG_SHAPE=1 node scripts/ingest.js`. The
[OpenAPI spec](https://transcripts.un.org/openapi) is the ground truth if
you need to re-verify anything.

## What's tracked, and what's deliberately not automated

- **No hardcoded crisis list.** Earlier versions of this script searched a
  fixed, hand-maintained list of crisis names — which silently misses
  whatever isn't on it. Instead, `ingest.js` runs a single broad full-text
  search for "OCHA" and figures out which country/countries each matched
  statement is about by pattern-matching the statement text (falling back to
  the meeting title) against the `COUNTRIES` gazetteer near the top of the
  file — all UN member states plus Palestine. A new crisis shows up on the
  map the moment OCHA's own transcripts mention it; nothing to edit here when
  the news changes. If you ever need to add a non-UN-member entity, add an
  entry to `COUNTRIES` following the existing pattern (watch for nested-name
  collisions with existing entries, e.g. "Sudan" vs. "South Sudan" — see the
  comment above `COUNTRIES` for how those are handled).
- **"Volume" measures OCHA-related activity, not general UN chatter.**
  Because everything now derives from one "OCHA" search, a country's signal
  volume is "OCHA's own statements about it + mentions of OCHA in statements
  about it" — not "how much the UN talks about it for any reason" the way an
  earlier per-country full-text search would have measured. The "elevated"
  threshold is computed relative to each run's own distribution (see
  `elevatedThreshold` in `main()`) rather than a fixed number, since this is
  a meaningfully smaller scale than the old metric was.
- **No "supportive / neutral / critical" stance** on the Member States on
  OCHA section. Classifying diplomatic language as critical of your own
  agency is an editorial judgment, not something to silently automate in a
  reputational-tracking tool — add it deliberately (human-reviewed, or a
  clearly-labeled AI pass with review) rather than guessing.
- **No text summarization.** Real statements can run long — the dashboard
  shows the raw matched text as-is. If that reads poorly in the compact card
  layout in practice, add a summarization step in `ingest.js`, and keep the
  raw text + video link alongside any summary for traceability.
- **Time range**: the site fetches up to `LOOKBACK_DAYS` (currently 180) of
  history per run, and the front-end's 30d/90d/All control filters within
  whatever was fetched — "All" is bounded by that same 180 days, not
  literally unlimited history.

## Local development

```bash
node scripts/ingest.js     # writes data/crises.json (needs real network access)
python3 -m http.server      # or any static server, then open index.html
```

`data/crises.json` ships pre-seeded with sample data (`generatedAt: null`) so
the page renders something reasonable before the first real Actions run
completes — the dashboard shows a "SEED DATA" badge until then.
