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
// DATA SHAPE (confirmed against a live response, 2026-08-25):
//
// GET /en/meetings.json?q=<query>&ft=1&from=YYYY-MM-DD&page=N ->
// {
//   "meetings": [{
//     "title", "date" (full ISO datetime), "body", "category", "slug",
//     "duration", "hasTranscript", "pageUrl" (site-relative, e.g. "/en/asset/..."),
//     "jsonUrl", "textUrl",
//     "matches": { "count": N, "statements": [{
//       "speaker": { "name": string|null, "group": string|null,
//                    "function": string|null, "affiliation": string|null },
//       "text": string, "start": number (seconds), "pageUrl": string (site-relative)
//     }] }
//   }],
//   "total", "totalIncludingOther", "hasMore", "page", "pageSize", "statementTotal"
// }
//
// Notable gotchas this script accounts for:
// - `speaker` is a structured object, not a plain string, and `name` can be null
//   (e.g. a briefing given by an unnamed "Spokesperson" — identify those by
//   `function`/`affiliation` instead).
// - `affiliation` is a country ISO3 code ("SDN") or org code ("OCHA", "UNFPA",
//   "UN") — a much more reliable signal for "who said this" than matching
//   substrings of a free-text speaker name.
// - `pageUrl` is site-relative on both the meeting and the statement — must be
//   made absolute before it's usable as a link.
// - The endpoint paginates (`hasMore`/`page`/`pageSize`); a single request only
//   gets page 1. This script pages through (capped) rather than assuming the
//   first page is everything.
//
// The `page` request parameter name is inferred (not documented) from the
// `page` field the API echoes back in its response — if pagination stops
// advancing (logged as [ingest][warn] "pagination stalled"), that guess is
// wrong; check https://transcripts.un.org/openapi for the real param name.
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const UN_BASE = "https://transcripts.un.org";
const OUTPUT_FILE = path.join(__dirname, "..", "data", "crises.json");
const LOOKBACK_DAYS = 90;
const MAX_PAGES_PER_QUERY = 5; // safety cap so a broad query (e.g. "OCHA") can't run away

const TRACKED_CRISES = [
  { id: "sudan", name: "Sudan", query: "Sudan", lon: 30, lat: 15 },
  { id: "gaza", name: "Gaza / oPt", query: "Gaza", lon: 34.3, lat: 31.5 },
  { id: "drc", name: "DR Congo", query: "Democratic Republic of the Congo", lon: 23, lat: -3 },
  { id: "yemen", name: "Yemen", query: "Yemen", lon: 48, lat: 15 },
  { id: "ukraine", name: "Ukraine", query: "Ukraine", lon: 31, lat: 49 },
  { id: "haiti", name: "Haiti", query: "Haiti", lon: -72, lat: 19 },
  { id: "myanmar", name: "Myanmar", query: "Myanmar", lon: 96, lat: 21 },
];

// Fallback only — affiliation-based detection (see isLeadershipStatement)
// catches unnamed OCHA speakers too; this is a secondary net for cases where
// affiliation doesn't say "OCHA" but the name/title clearly does.
const LEADERSHIP_MARKERS = [
  "Fletcher",
  "Emergency Relief Coordinator",
  "Under-Secretary-General for Humanitarian",
];

const OCHA_AFFILIATION_HINTS = ["OCHA"];

const BRIEFING_SLUG_HINTS = ["/briefing/sg/", "/briefing/geneva/", "/briefing/pga/"];

// ISO3 -> short name for the common set likely to show up speaking about
// tracked crises at the UN. Falls back to the raw code for anything missing —
// extend this table as unfamiliar codes show up in practice.
const COUNTRY_NAMES = {
  AFG: "Afghanistan", ALB: "Albania", DZA: "Algeria", ARG: "Argentina", ARM: "Armenia",
  AUS: "Australia", AUT: "Austria", AZE: "Azerbaijan", BHR: "Bahrain", BGD: "Bangladesh",
  BLR: "Belarus", BEL: "Belgium", BEN: "Benin", BOL: "Bolivia", BIH: "Bosnia and Herzegovina",
  BWA: "Botswana", BRA: "Brazil", BGR: "Bulgaria", BFA: "Burkina Faso", BDI: "Burundi",
  KHM: "Cambodia", CMR: "Cameroon", CAN: "Canada", CAF: "Central African Republic",
  TCD: "Chad", CHL: "Chile", CHN: "China", COL: "Colombia", COD: "DR Congo", COG: "Congo",
  CRI: "Costa Rica", HRV: "Croatia", CUB: "Cuba", CYP: "Cyprus", CZE: "Czechia",
  DNK: "Denmark", DJI: "Djibouti", DOM: "Dominican Republic", ECU: "Ecuador", EGY: "Egypt",
  SLV: "El Salvador", EST: "Estonia", ETH: "Ethiopia", FJI: "Fiji", FIN: "Finland",
  FRA: "France", GAB: "Gabon", GMB: "Gambia", GEO: "Georgia", DEU: "Germany", GHA: "Ghana",
  GRC: "Greece", GTM: "Guatemala", GIN: "Guinea", GUY: "Guyana", HTI: "Haiti",
  HND: "Honduras", HUN: "Hungary", ISL: "Iceland", IND: "India", IDN: "Indonesia",
  IRN: "Iran", IRQ: "Iraq", IRL: "Ireland", ISR: "Israel", ITA: "Italy", JAM: "Jamaica",
  JPN: "Japan", JOR: "Jordan", KAZ: "Kazakhstan", KEN: "Kenya", KWT: "Kuwait",
  KGZ: "Kyrgyzstan", LAO: "Laos", LVA: "Latvia", LBN: "Lebanon", LSO: "Lesotho",
  LBR: "Liberia", LBY: "Libya", LIE: "Liechtenstein", LTU: "Lithuania", LUX: "Luxembourg",
  MDG: "Madagascar", MWI: "Malawi", MYS: "Malaysia", MDV: "Maldives", MLI: "Mali",
  MLT: "Malta", MRT: "Mauritania", MEX: "Mexico", MDA: "Moldova", MCO: "Monaco",
  MNG: "Mongolia", MNE: "Montenegro", MAR: "Morocco", MOZ: "Mozambique", MMR: "Myanmar",
  NAM: "Namibia", NPL: "Nepal", NLD: "Netherlands", NZL: "New Zealand", NIC: "Nicaragua",
  NER: "Niger", NGA: "Nigeria", PRK: "North Korea", MKD: "North Macedonia", NOR: "Norway",
  OMN: "Oman", PAK: "Pakistan", PAN: "Panama", PNG: "Papua New Guinea", PRY: "Paraguay",
  PER: "Peru", PHL: "Philippines", POL: "Poland", PRT: "Portugal", PSE: "Palestine",
  QAT: "Qatar", ROU: "Romania", RUS: "Russia", RWA: "Rwanda", SAU: "Saudi Arabia",
  SEN: "Senegal", SRB: "Serbia", SLE: "Sierra Leone", SGP: "Singapore", SVK: "Slovakia",
  SVN: "Slovenia", SOM: "Somalia", ZAF: "South Africa", KOR: "South Korea",
  SSD: "South Sudan", ESP: "Spain", LKA: "Sri Lanka", SDN: "Sudan", SUR: "Suriname",
  SWE: "Sweden", CHE: "Switzerland", SYR: "Syria", TJK: "Tajikistan", TZA: "Tanzania",
  THA: "Thailand", TGO: "Togo", TTO: "Trinidad and Tobago", TUN: "Tunisia",
  TUR: "Turkey", TKM: "Turkmenistan", UGA: "Uganda", UKR: "Ukraine",
  ARE: "United Arab Emirates", GBR: "United Kingdom", USA: "United States",
  URY: "Uruguay", UZB: "Uzbekistan", VEN: "Venezuela", VNM: "Vietnam", YEM: "Yemen",
  ZMB: "Zambia", ZWE: "Zimbabwe",
};

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

function toAbsoluteUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return UN_BASE + (u.startsWith("/") ? u : `/${u}`);
}

// The top-level list of matched meetings could be under several plausible keys
// depending on the real API shape — confirmed live as "meetings", kept
// tolerant of a couple of other plausible names as a safety net.
function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const candidates = ["meetings", "items", "results", "data", "records"];
  for (const key of candidates) {
    if (Array.isArray(data[key])) return data[key];
  }
  return [];
}

// Same idea for the per-meeting list of matched statements — confirmed live
// as matches.statements.
function extractStatements(item) {
  if (item && item.matches && Array.isArray(item.matches.statements)) {
    return item.matches.statements;
  }
  const candidates = ["statements", "hits", "snippets", "matched_statements"];
  for (const key of candidates) {
    if (Array.isArray(item[key])) return item[key];
  }
  if (typeof item.text === "string" || typeof item.snippet === "string" || typeof item.excerpt === "string") {
    return [item];
  }
  return [];
}

// statement.speaker is a structured object ({name, group, function,
// affiliation}), any field of which can be null — never assume it's a string.
function speakerFields(statement) {
  const s = statement && typeof statement === "object" ? statement.speaker : undefined;
  if (s && typeof s === "object") {
    return {
      name: s.name || null,
      group: s.group || null,
      function: s.function || null,
      affiliation: s.affiliation || null,
    };
  }
  if (typeof s === "string" && s) {
    return { name: s, group: null, function: null, affiliation: null };
  }
  return { name: null, group: null, function: null, affiliation: null };
}

function displaySpeaker({ name, function: fn, affiliation }) {
  const place = affiliation ? COUNTRY_NAMES[affiliation] || affiliation : null;
  if (name) return name;
  if (fn && place) return `${fn} (${place})`;
  if (fn) return fn;
  if (place) return place;
  return "Unknown speaker";
}

function normalizeMatch(meetingItem, statement) {
  const sp = speakerFields(statement);
  const rawPageUrl =
    pick(statement, ["pageUrl", "page_url", "url", "link"]) ||
    pick(meetingItem, ["pageUrl", "page_url", "url", "link"]);
  const pageUrl = toAbsoluteUrl(rawPageUrl);
  return {
    date: (
      pick(statement, ["date"]) ||
      pick(meetingItem, ["date", "scheduled_time", "start_date"]) ||
      ""
    ).slice(0, 10),
    speaker: displaySpeaker(sp),
    speakerAffiliation: sp.affiliation || "",
    speakerFunction: sp.function || "",
    text: (pick(statement, ["text", "snippet", "excerpt", "highlight", "content"]) || "").trim(),
    t: formatSeconds(pick(statement, ["start", "start_time", "startTime", "timestamp", "offset"])),
    pageUrl,
    category: meetingItem.category,
    isBriefing: BRIEFING_SLUG_HINTS.some((h) => (rawPageUrl || "").includes(h)),
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
  const out = [];
  let page = 1;
  let firstUrl = null;

  while (page <= MAX_PAGES_PER_QUERY) {
    const params = new URLSearchParams({ q: query, ft: "1", page: String(page) });
    if (from) params.set("from", from);
    const url = `${UN_BASE}/en/meetings.json?${params.toString()}`;
    if (page === 1) firstUrl = url;

    const data = await fetchJSON(url);

    if (DEBUG_SHAPE && !debugPrinted) {
      debugPrinted = true;
      console.log(`[ingest][debug] URL: ${url}`);
      console.log(`[ingest][debug] top-level keys: ${JSON.stringify(Array.isArray(data) ? "(array)" : Object.keys(data))}`);
      console.log(`[ingest][debug] raw sample (first 4000 chars):`);
      console.log(JSON.stringify(data, null, 2).slice(0, 4000));
    }

    const items = extractItems(data);
    for (const item of items) {
      const statements = extractStatements(item);
      for (const s of statements) out.push(normalizeMatch(item, s));
    }

    if (page === 1 && items.length === 0 && !warnedZeroShapeOnce) {
      warnedZeroShapeOnce = true;
      logShapeDiagnostics(
        `query "${query}" returned 0 normalized matches — response shape likely doesn't match any of the guesses in extractItems/extractStatements/normalizeMatch.`,
        url,
        data,
        items
      );
    }

    const hasMore = !!(data && typeof data === "object" && data.hasMore === true);
    if (!hasMore) break;

    // Guard against the "page" request-param name guess being wrong: if the
    // API keeps echoing the same page number back despite us asking for the
    // next one, further looping would just refetch page 1 forever.
    const reportedPage = data && typeof data === "object" ? data.page : undefined;
    if (reportedPage !== undefined && reportedPage === page && page > 1) {
      console.warn(`[ingest][warn] pagination stalled on "${query}" — API still reports page ${reportedPage} after requesting page ${page + 1}. Stopping early; check the "page" query-param name against https://transcripts.un.org/openapi.`);
      break;
    }

    page += 1;
  }

  if (page > MAX_PAGES_PER_QUERY) {
    console.warn(`[ingest][warn] query "${query}" hit the ${MAX_PAGES_PER_QUERY}-page cap (URL: ${firstUrl}) — there may be more matches than were collected.`);
  }

  totalNormalizedMatches += out.length;
  return out;
}

function isLeadershipStatement(match) {
  const aff = (match.speakerAffiliation || "").toUpperCase();
  if (OCHA_AFFILIATION_HINTS.some((h) => aff.includes(h))) return true;
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

function stripInternal({ date, speaker, speakerAffiliation, speakerFunction, text, t, pageUrl }) {
  return { date, speaker, speakerAffiliation, speakerFunction, text, t, pageUrl };
}

async function ingestCrisis(crisis) {
  const from = dateNDaysAgo(LOOKBACK_DAYS);
  const matches = await searchStatements(crisis.query, { from });

  // crisis.query is a broad full-text search (just the crisis name), so
  // `matches` includes statements from anyone — SC presidents reading the
  // procedural agenda, unrelated delegations, other crises mentioned in
  // passing. All three columns below are specifically about what OCHA said,
  // so they're filtered down to OCHA speakers (via speakerAffiliation, with
  // a name/title fallback — see isLeadershipStatement) before anything else.
  // Each OCHA statement then lands in exactly one bucket by venue, so the
  // same statement never gets double-counted across columns.
  const ocha = matches.filter((m) => isLeadershipStatement(m));
  const briefings = ocha.filter((m) => m.isBriefing);
  const sc = ocha.filter((m) => !m.isBriefing && m.category === "Security Council");
  const leadership = ocha.filter((m) => !m.isBriefing && m.category !== "Security Council");

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
    top: (leadership[0] || sc[0] || briefings[0] || matches[0] || {}).text || "",
    briefings: briefings.slice(0, 20).map(stripInternal),
    leadership: leadership.slice(0, 20).map(stripInternal),
    sc: sc.slice(0, 20).map(stripInternal),
  };
}

// See the earlier caution in README.md: no automated "supportive/critical"
// stance here on purpose — that's an editorial call, not an extraction task.
//
// This intentionally stays a single global "OCHA" search rather than being
// folded into the per-crisis searches above: it's the only way to catch every
// member state that mentions OCHA, regardless of which (if any) tracked
// crisis they're discussing. The per-crisis searches above exist for the
// opposite reason — to catch OCHA's own statements about a crisis even when
// the statement itself never says the word "OCHA" (a spokesperson rarely
// names their own office). Classification of *who* is speaking, in both
// directions, now runs off the structured `affiliation` field rather than
// text-matching, which is the fix for both.
async function ingestOchaMentions() {
  const from = dateNDaysAgo(LOOKBACK_DAYS);
  const matches = await searchStatements("OCHA", { from });

  const byCrisis = {};
  TRACKED_CRISES.forEach((c) => (byCrisis[c.id] = []));

  matches.forEach((m) => {
    // Skip OCHA speaking about itself — this section is about *other* voices.
    if (isLeadershipStatement(m)) return;

    const country = m.speakerAffiliation ? COUNTRY_NAMES[m.speakerAffiliation] || m.speakerAffiliation : m.speaker;
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
