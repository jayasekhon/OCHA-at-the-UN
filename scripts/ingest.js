// scripts/ingest.js
//
// One-shot version of the ingestion logic: fetches tracked crises + OCHA
// mentions from the UN Transcripts API and writes ../data/crises.json.
// Run by .github/workflows/refresh-data.yml on a schedule; GitHub Pages then
// serves that JSON file statically — no server, no CORS, no uptime to manage.
//
// Run locally with: node scripts/ingest.js
//
// -----------------------------------------------------------------------------
// DATA-SHAPE NOTE (read before relying on this):
// Built against the documented behavior in https://transcripts.un.org/llms.txt.
// I directly confirmed the *meeting-detail* JSON shape (GET /en/{slug}.json),
// but could not execute a live `?ft=1` search request from my environment, so
// the field names inside `matches.statements[]` (assumed: `speaker`, `text`,
// `start`, `pageUrl`) are inferred from docs, not verified byte-for-byte.
// Before trusting this: run
//   curl "https://transcripts.un.org/en/meetings.json?q=OCHA&ft=1" | jq .
// and diff against normalizeMatch() below. The OpenAPI spec at
// https://transcripts.un.org/openapi.json is the source of truth.
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const UN_BASE = "https://transcripts.un.org";
const OUTPUT_FILE = path.join(__dirname, "..", "data", "crises.json");
const LOOKBACK_DAYS = 90;

const TRACKED_CRISES = [
  { id: "sudan", name: "Sudan", query: "Sudan", lon: 30, lat: 15 },
  { id: "gaza", name: "Gaza / oPt", query: "Gaza", lon: 34.3, lat: 31.5 },
  { id: "drc", name: "DR Congo", query: "Democratic Republic of the Congo", lon: 23, lat: -3 },
  { id: "yemen", name: "Yemen", query: "Yemen", lon: 48, lat: 15 },
  { id: "ukraine", name: "Ukraine", query: "Ukraine", lon: 31, lat: 49 },
  { id: "haiti", name: "Haiti", query: "Haiti", lon: -72, lat: 19 },
  { id: "myanmar", name: "Myanmar", query: "Myanmar", lon: 96, lat: 21 },
];

const LEADERSHIP_MARKERS = [
  "Fletcher",
  "Emergency Relief Coordinator",
  "Under-Secretary-General for Humanitarian",
  "Secretary-General",
];

const BRIEFING_SLUG_HINTS = ["/briefing/sg/", "/briefing/geneva/", "/briefing/pga/"];

async function fetchJSON(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ocha-un-pulse-ingest/0.1 (github actions)" },
  });
  if (!res.ok) {
    throw new Error(`UN Transcripts request failed: ${res.status} ${res.statusText} — ${url}`);
  }
  return res.json();
}

function dateNDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function formatSeconds(s) {
  if (typeof s !== "number") return "";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function normalizeMatch(meetingItem, statement) {
  return {
    date: (statement.date || meetingItem.date || meetingItem.scheduled_time || "").slice(0, 10),
    speaker: statement.speaker || "Unknown speaker",
    text: (statement.text || statement.snippet || "").trim(),
    t: formatSeconds(statement.start),
    pageUrl: statement.pageUrl || meetingItem.pageUrl,
    category: meetingItem.category,
    isBriefing: BRIEFING_SLUG_HINTS.some((h) => (meetingItem.pageUrl || "").includes(h)),
  };
}

const DEBUG_SHAPE = process.env.INGEST_DEBUG_SHAPE === "1";
let debugPrinted = false;

async function searchStatements(query, { from } = {}) {
  const params = new URLSearchParams({ q: query, ft: "1" });
  if (from) params.set("from", from);
  const url = `${UN_BASE}/en/meetings.json?${params.toString()}`;

  const data = await fetchJSON(url);
  if (DEBUG_SHAPE && !debugPrinted) {
    debugPrinted = true;
    console.log(`[ingest][debug] URL: ${url}`);
    console.log(`[ingest][debug] top-level keys: ${JSON.stringify(Object.keys(data))}`);
    console.log(`[ingest][debug] raw sample (first 4000 chars):`);
    console.log(JSON.stringify(data, null, 2).slice(0, 4000));
  }
  const items = data.items || data.results || []; // defensive: field name unverified
  const out = [];
  for (const item of items) {
    const statements = item.matches?.statements || [];
    for (const s of statements) out.push(normalizeMatch(item, s));
  }
  return out;
}

function isLeadershipStatement(match) {
  return LEADERSHIP_MARKERS.some((marker) => match.speaker.includes(marker));
}

function weeklyTrend(matches, weeks = 12) {
  const buckets = new Array(weeks).fill(0);
  const now = new Date();
  matches.forEach((m) => {
    if (!m.date) return;
    const days = Math.floor((now - new Date(m.date)) / 86400000);
    const week = weeks - 1 - Math.floor(days / 7);
    if (week >= 0 && week < weeks) buckets[week]++;
  });
  return buckets;
}

function stripInternal({ date, speaker, text, t, pageUrl }) {
  return { date, speaker, text, t, pageUrl };
}

async function ingestCrisis(crisis) {
  const from = dateNDaysAgo(LOOKBACK_DAYS);
  const matches = await searchStatements(crisis.query, { from });

  const briefings = matches.filter((m) => m.isBriefing);
  const sc = matches.filter((m) => m.category === "Security Council" && !m.isBriefing);
  const leadership = matches.filter((m) => isLeadershipStatement(m) && !briefings.includes(m));

  const recent30 = matches.filter((m) => m.date >= dateNDaysAgo(30));
  const trend = weeklyTrend(matches, 12);

  return {
    id: crisis.id,
    name: crisis.name,
    lon: crisis.lon,
    lat: crisis.lat,
    volume: recent30.length,
    level: recent30.length >= 70 ? "elevated" : "standard",
    trend,
    top: (leadership[0] || matches[0] || {}).text || "",
    briefings: briefings.slice(0, 20).map(stripInternal),
    leadership: leadership.slice(0, 20).map(stripInternal),
    sc: sc.slice(0, 20).map(stripInternal),
  };
}

// See the earlier caution in README.md: no automated "supportive/critical"
// stance here on purpose — that's an editorial call, not an extraction task.
async function ingestOchaMentions() {
  const from = dateNDaysAgo(LOOKBACK_DAYS);
  const matches = await searchStatements("OCHA", { from });

  const byCrisis = {};
  TRACKED_CRISES.forEach((c) => (byCrisis[c.id] = []));

  matches.forEach((m) => {
    const country = m.speaker;
    const matchedCrisis = TRACKED_CRISES.find((c) =>
      (m.text || "").toLowerCase().includes(c.name.toLowerCase().split(" / ")[0].toLowerCase())
    );
    if (matchedCrisis) {
      byCrisis[matchedCrisis.id].push({
        date: m.date,
        country,
        text: m.text,
        t: m.t,
        pageUrl: m.pageUrl,
      });
    }
  });

  return byCrisis;
}

async function main() {
  console.log(`[ingest] starting ${new Date().toISOString()}`);

  const [crisisResults, ochaByCrisis] = await Promise.all([
    Promise.all(
      TRACKED_CRISES.map((c) =>
        ingestCrisis(c).catch((err) => {
          console.error(`[ingest] failed for ${c.id}:`, err.message);
          return null;
        })
      )
    ),
    ingestOchaMentions().catch((err) => {
      console.error("[ingest] OCHA-mentions search failed:", err.message);
      return {};
    }),
  ]);

  const crises = crisisResults.filter(Boolean).map((c) => ({ ...c, onOcha: ochaByCrisis[c.id] || [] }));

  if (crises.length === 0) {
    console.error("[ingest] no crises ingested successfully — leaving existing data/crises.json untouched");
    process.exit(1);
  }

  const output = { generatedAt: new Date().toISOString(), crises };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[ingest] wrote ${crises.length} crises to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
