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
// The exact JSON field names returned by GET /en/meetings.json?ft=1 have never
// been directly confirmed against a live response (the environment that wrote
// this script could not reach transcripts.un.org). extractItems/extractStatements/
// normalizeMatch below are deliberately written to tolerate several plausible
// shapes (items/results/meetings/data/hits/records, matches.statements/matches/
// statements/hits/snippets, speaker/speaker_name/name, text/snippet/excerpt/
// highlight, etc.) rather than assuming one exact shape.
//
// If every query still comes back with 0 normalized matches, the shape simply
// isn't one of the guesses below. When that happens this script prints a
// [ingest][warn] block with the real top-level keys, the first item's keys,
// and a raw JSON sample — check the Actions log for that. You can also force
// a full raw dump on every run via the "debug_shape" input on the
// "Refresh UN Transcripts data" workflow (Actions tab → Run workflow), or
// locally with INGEST_DEBUG_SHAPE=1 node scripts/ingest.js. Update
// extractItems/extractStatements/normalizeMatch with whatever the real field
// names turn out to be. The OpenAPI spec at https://transcripts.un.org/openapi
// is the source of truth.
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

const DEBUG_SHAPE = process.env.INGEST_DEBUG_SHAPE === "1";
let debugPrinted = false;
let warnedZeroShapeOnce = false;
let totalNormalizedMatches = 0;

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
  if (typeof s === "number") {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  }
  // some APIs already give a formatted string (mm:ss, ISO timestamp, etc.) — pass through
  if (typeof s === "string") return s;
  return "";
}

// Returns the first non-empty value found on `obj` across `keys`, or undefined.
function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

// The top-level list of matched meetings could be under several plausible keys
// depending on the real API shape — try the obvious candidates in order.
function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const candidates = ["items", "results", "meetings", "data", "records", "hits", "documents"];
  for (const key of candidates) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

// Same idea for the per-meeting list of matched statements. Falls back to
// treating the meeting item itself as a single statement if it already looks
// like one (flat search-result shape rather than nested meeting+statements).
function extractStatements(item) {
  if (item && item.matches && Array.isArray(item.matches.statements)) {
    return item.matches.statements;
  }
  const candidates = ["statements", "matches", "hits", "snippets", "matched_statements"];
  for (const key of candidates) {
    if (Array.isArray(item[key])) return item[key];
  }
  if (typeof item.text === "string" || typeof item.snippet === "string" || typeof item.excerpt === "string") {
    return [item];
  }
  return [];
}

function normalizeMatch(meetingItem, statement) {
  const pageUrl =
    pick(statement, ["pageUrl", "page_url", "url", "link"]) ||
    pick(meetingItem, ["pageUrl", "page_url", "url", "link"]);
  return {
    date: (
      pick(statement, ["date"]) ||
      pick(meetingItem, ["date", "scheduled_time", "start_date"]) ||
      ""
    ).slice(0, 10),
    speaker: pick(statement, ["speaker", "speaker_name", "speakerName", "name", "by"]) || "Unknown speaker",
    text: (pick(statement, ["text", "snippet", "excerpt", "highlight", "content"]) || "").trim(),
    t: formatSeconds(pick(statement, ["start", "start_time", "startTime", "timestamp", "offset"])),
    pageUrl,
    category: meetingItem.category,
    isBriefing: BRIEFING_SLUG_HINTS.some((h) => (pageUrl || "").includes(h)),
  };
}

function logShapeDiagnostics(label, url, data, items) {
  console.warn(`[ingest][warn] ${label}`);
  console.warn(`[ingest][warn] URL: ${url}`);
  console.warn(`[ingest][warn] top-level keys: ${JSON.stringify(Array.isArray(data) ? "(array)" : Object.keys(data))}`);
  if (items.length) {
    console.warn(`[ingest][warn] first extracted item's keys: ${JSON.stringify(Object.keys(items[0]))}`);
  }
  console.warn(`[ingest][warn] raw sample (first 2500 chars): ${JSON.stringify(data).slice(0, 2500)}`);
}

async function searchStatements(query, { from } = {}) {
  const params = new URLSearchParams({ q: query, ft: "1" });
  if (from) params.set("from", from);
  const url = `${UN_BASE}/en/meetings.json?${params.toString()}`;

  const data = await fetchJSON(url);

  if (DEBUG_SHAPE && !debugPrinted) {
    debugPrinted = true;
    console.log(`[ingest][debug] URL: ${url}`);
    console.log(`[ingest][debug] top-level keys: ${JSON.stringify(Array.isArray(data) ? "(array)" : Object.keys(data))}`);
    console.log(`[ingest][debug] raw sample (first 4000 chars):`);
    console.log(JSON.stringify(data, null, 2).slice(0, 4000));
  }

  const items = extractItems(data);
  const out = [];
  for (const item of items) {
    const statements = extractStatements(item);
    for (const s of statements) out.push(normalizeMatch(item, s));
  }

  if (out.length === 0 && !warnedZeroShapeOnce) {
    warnedZeroShapeOnce = true;
    logShapeDiagnostics(
      `query "${query}" returned 0 normalized matches — response shape likely doesn't match any of the guesses in extractItems/extractStatements/normalizeMatch.`,
      url,
      data,
      items
    );
  }

  totalNormalizedMatches += out.length;
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

  // A 90-day lookback across 7 major crises plus a bare "OCHA" query returning
  // *zero* matches, with no fetch errors, is a strong signal the response
  // shape doesn't match extractItems/extractStatements — not that nothing
  // happened at the UN in 90 days. Surface that loudly instead of silently
  // committing a "successful" empty dataset that the site would then label
  // as live.
  const dataQuality = totalNormalizedMatches === 0 ? "no-matches" : "ok";
  if (dataQuality === "no-matches") {
    console.error(
      "[ingest] every query returned 0 normalized matches across all crises + OCHA mentions. " +
        "This almost certainly means the UN Transcripts response shape doesn't match this script's " +
        "assumptions — see the [ingest][warn] block(s) above for the raw shape, fix extractItems/" +
        "extractStatements/normalizeMatch accordingly, and re-run. Writing the file anyway with " +
        'dataQuality: "no-matches" so the site can show an honest "no data" state instead of a ' +
        "misleading live-but-empty one."
    );
  }

  const output = { generatedAt: new Date().toISOString(), dataQuality, crises };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[ingest] wrote ${crises.length} crises (dataQuality: ${dataQuality}) to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
