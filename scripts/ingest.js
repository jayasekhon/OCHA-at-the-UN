// scripts/ingest.js
//
// Fetches OCHA's footprint across UN meeting transcripts and writes
// ../data/crises.json. Run by .github/workflows/refresh-data.yml on a
// schedule; GitHub Pages then serves that JSON file statically — no server,
// no CORS, no uptime to manage.
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
//
// -----------------------------------------------------------------------------
// COUNTRY/CRISIS DISCOVERY (no more hardcoded crisis list):
//
// Earlier versions of this script searched a fixed, hand-maintained list of
// crisis names (Sudan, Gaza, DRC, ...). That's a curated list that silently
// misses whatever isn't on it — no help when a new conflict emerges. Instead:
//
// 1. Run ONE broad full-text search for "OCHA" (paginated).
// 2. For every matched statement, detect which country/countries it's about
//    by pattern-matching the statement text against the COUNTRIES gazetteer
//    below (all UN member states + a couple of observer entities), falling
//    back to the meeting title when the text excerpt itself doesn't name one.
// 3. Split each match into "OCHA said this" vs. "a member state mentioned
//    OCHA" via the same speakerAffiliation-based isLeadershipStatement()
//    check used before, bucketed by whichever country/countries were detected
//    rather than a pre-declared one.
//
// A new crisis appears on the map the moment OCHA's own transcripts mention
// it — nothing to edit here when the news changes. The trade-off: "volume"
// now measures OCHA-related activity specifically (OCHA's own statements +
// mentions of OCHA), not general UN discourse about a country the way the
// old per-crisis-name search did — a deliberate, more honest metric for a
// site called "OCHA at the UN," but worth knowing if a country's apparent
// activity level looks different from before.
//
// Text-matching country names is not risk-free — "Sudan" is a substring of
// "South Sudan", "Korea"/"Congo" are ambiguous between two countries each,
// etc. Known collisions get explicit patterns (see COUNTRIES below); a
// handful of genuinely ambiguous common-word names (Georgia vs. the US
// state, Jordan/Chad as given names) are accepted as a small, documented
// residual risk rather than over-engineered away.
// -----------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");

const UN_BASE = "https://transcripts.un.org";
const OUTPUT_FILE = path.join(__dirname, "..", "data", "crises.json");
const LOOKBACK_DAYS = 180; // the site's front-end time filter can only offer up to this
const MAX_PAGES_PER_QUERY = 20; // a handful of queries instead of 16+ per-country ones, so this can go deeper for a similar total request budget
const MAX_CRISES_SHOWN = 40; // keep the map/columns readable even if OCHA activity touches many countries in the window

// Searching only "OCHA" misses most of what OCHA itself actually says: a
// leadership statement to the Security Council routinely never utters the
// word "OCHA" ("I pay tribute to the people of Sudan, who are in desperate
// need..." — no self-naming at all), so a bare "OCHA" full-text search
// systematically under-catches OCHA's own briefings/leadership/SC
// statements while still catching every *mention* of OCHA by someone else
// fine (member states do tend to say "OCHA" when thanking or citing it).
// These are the queries run to compensate — deliberately official job
// titles, not people's names or crisis names: titles are what a rotating
// UN president's introduction or a transcript header reliably uses
// regardless of who currently holds the office, and unlike a crisis list
// they don't go stale as the news cycle moves. Results across all queries
// are merged and de-duplicated by pageUrl before anything else runs.
//
// This is still an incomplete net, not a structural fix: it only catches a
// briefer whose own matched excerpt contains one of these exact phrases (or
// says "OCHA" itself). An unexpected briefer — a Director of Operations, a
// Deputy ERC, anyone OCHA sends who isn't introduced with one of these
// titles and doesn't self-name — is invisible to this pipeline entirely,
// not misclassified. The complete fix would fetch every Security
// Council/press-briefing meeting's full statement list directly (by
// speaker.affiliation, not by keyword) rather than relying on full-text
// search turning up the right phrase; that's a bigger change (a new,
// unverified endpoint shape, many more per-meeting requests) that hasn't
// been built yet.
const OCHA_IDENTITY_QUERIES = [
  "OCHA",
  "Emergency Relief Coordinator",
  "Deputy Emergency Relief Coordinator",
  "Under-Secretary-General for Humanitarian Affairs",
  "Assistant Secretary-General for Humanitarian Affairs",
  "Director of Operations",
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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds one country/entity entry for the gazetteer. `patterns`, if given,
// overrides the default plain word-boundary match on `name` — used for
// names that need extra care (ambiguous with another country, or need
// additional aliases).
function place(id, name, lon, lat, patterns) {
  const pats = patterns || [`\\b${escapeRegex(name)}\\b`];
  return { id, name, lon, lat, regex: new RegExp(pats.join("|")) };
}

// All ~190 UN member states plus Palestine, so a genuinely new crisis is
// discoverable rather than silently dropped for not being on a pre-approved
// list. Coordinates are approximate centroids — this is a schematic map, not
// a survey. Regex patterns are case-sensitive (proper nouns are capitalized
// in transcripts, which also reduces accidental matches on common words) and
// word-boundary wrapped; a handful get explicit exclusions/aliases below to
// avoid nested-name collisions (Sudan/South Sudan, Niger/Nigeria, the two
// Congos, the two Koreas, Guinea/Guinea-Bissau/Equatorial Guinea/Papua New
// Guinea).
const COUNTRIES = [
  place("afg", "Afghanistan", 66, 34),
  place("alb", "Albania", 20, 41),
  place("dza", "Algeria", 3, 28),
  place("and", "Andorra", 1.5, 42.5),
  place("ago", "Angola", 17, -12),
  place("atg", "Antigua and Barbuda", -61.8, 17.1),
  place("arg", "Argentina", -64, -34),
  place("arm", "Armenia", 45.0, 40.1),
  place("aus", "Australia", 134, -25.7),
  place("aut", "Austria", 14.5, 47.5),
  place("aze", "Azerbaijan", 47.6, 40.1),
  place("bhs", "Bahamas", -77.4, 25.0),
  place("bhr", "Bahrain", 50.6, 26.0),
  place("bgd", "Bangladesh", 90.4, 23.7),
  place("brb", "Barbados", -59.5, 13.2),
  place("blr", "Belarus", 28, 53.7),
  place("bel", "Belgium", 4.5, 50.8),
  place("blz", "Belize", -88.5, 17.2),
  place("ben", "Benin", 2.3, 9.3),
  place("btn", "Bhutan", 90.4, 27.5),
  place("bol", "Bolivia", -64.7, -16.3),
  place("bih", "Bosnia and Herzegovina", 17.8, 44.2),
  place("bwa", "Botswana", 24, -22),
  place("bra", "Brazil", -51.9, -14.2),
  place("brn", "Brunei", 114.7, 4.5),
  place("bgr", "Bulgaria", 25.5, 42.7),
  place("bfa", "Burkina Faso", -1.5, 12.4),
  place("bdi", "Burundi", 30, -3.4),
  place("cpv", "Cabo Verde", -24, 16),
  place("khm", "Cambodia", 105, 12.6),
  place("cmr", "Cameroon", 12.5, 5.7),
  place("can", "Canada", -106, 56),
  place("caf", "Central African Republic", 21, 6.6),
  place("tcd", "Chad", 19, 15.5),
  place("chl", "Chile", -71, -35.7),
  place("chn", "China", 104, 35.9),
  place("col", "Colombia", -74.3, 4.6),
  place("com", "Comoros", 43.3, -11.9),
  // The two Congos: avoid a bare "Congo" pattern on the Republic of the
  // Congo (rarer referent in this corpus) so it doesn't swallow DRC mentions;
  // DRC keeps bare "Congo" since that's overwhelmingly what's meant when the
  // fuller name isn't used, but excludes it when preceded by "Republic of
  // (the)" so it doesn't also claim Congo-Brazzaville mentions.
  place("cod", "DR Congo", 23, -3, [
    "\\bDemocratic Republic of the Congo\\b",
    "\\bDR Congo\\b",
    "\\bDRC\\b",
    "(?<!Republic of the )(?<!Republic of )\\bCongo\\b",
  ]),
  place("cog", "Republic of the Congo", 15.8, -1, [
    "\\bRepublic of the Congo\\b",
    "\\bCongo-Brazzaville\\b",
  ]),
  place("cri", "Costa Rica", -84.1, 9.7),
  place("civ", "Côte d'Ivoire", -5.5, 7.5, ["\\bCôte d'Ivoire\\b", "\\bIvory Coast\\b"]),
  place("hrv", "Croatia", 15.2, 45.1),
  place("cub", "Cuba", -77.8, 21.5),
  place("cyp", "Cyprus", 33.4, 35.1),
  place("cze", "Czechia", 15.5, 49.8, ["\\bCzechia\\b", "\\bCzech Republic\\b"]),
  place("dnk", "Denmark", 10, 56),
  place("dji", "Djibouti", 42.5, 11.6),
  place("dma", "Dominica", -61.4, 15.4),
  place("dom", "Dominican Republic", -70.2, 18.7),
  place("ecu", "Ecuador", -78.2, -1.8),
  place("egy", "Egypt", 30, 26.8),
  place("slv", "El Salvador", -88.9, 13.8),
  place("gnq", "Equatorial Guinea", 10.3, 1.6),
  place("eri", "Eritrea", 39, 15.2),
  place("est", "Estonia", 25.0, 58.6),
  place("swz", "Eswatini", 31.5, -26.5, ["\\bEswatini\\b", "\\bSwaziland\\b"]),
  place("eth", "Ethiopia", 40, 9),
  place("fji", "Fiji", 178, -17.7),
  place("fin", "Finland", 26, 64.5),
  place("fra", "France", 2.2, 46.6),
  place("gab", "Gabon", 11.6, -0.8),
  place("gmb", "Gambia", -15.3, 13.5),
  place("geo", "Georgia", 43.4, 42.3),
  place("deu", "Germany", 10.5, 51.2),
  place("gha", "Ghana", -1.0, 7.9),
  place("grc", "Greece", 22, 39),
  place("grd", "Grenada", -61.7, 12.1),
  place("gtm", "Guatemala", -90.2, 15.8),
  place("gin", "Guinea", -9.7, 10.4, ["(?<!Equatorial )(?<!Papua New )\\bGuinea\\b(?!-Bissau)"]),
  place("gnb", "Guinea-Bissau", -15, 12),
  place("guy", "Guyana", -58.9, 4.9),
  place("hti", "Haiti", -72, 19),
  place("hnd", "Honduras", -86.6, 15.2),
  place("hun", "Hungary", 19.5, 47.2),
  place("isl", "Iceland", -19, 65),
  place("ind", "India", 79, 22),
  place("idn", "Indonesia", 113.9, 0.8),
  place("irn", "Iran", 53.7, 32.4),
  place("irq", "Iraq", 43.7, 33.2),
  place("irl", "Ireland", -8, 53.4),
  place("isr", "Israel", 34.9, 31.0),
  place("ita", "Italy", 12.6, 42.8),
  place("jam", "Jamaica", -77.3, 18.1),
  place("jpn", "Japan", 138, 36.2),
  place("jor", "Jordan", 36.2, 31.2),
  place("kaz", "Kazakhstan", 66.9, 48.0),
  place("ken", "Kenya", 37.9, 0.0),
  place("kir", "Kiribati", -157.4, 1.4),
  place("prk", "North Korea", 127.5, 40.3, [
    "\\bNorth Korea\\b",
    "\\bDPRK\\b",
    "\\bDemocratic People's Republic of Korea\\b",
  ]),
  place("kor", "South Korea", 127.8, 36.5, ["\\bSouth Korea\\b", "\\bRepublic of Korea\\b"]),
  place("kwt", "Kuwait", 47.5, 29.3),
  place("kgz", "Kyrgyzstan", 74.8, 41.2),
  place("lao", "Laos", 102.5, 19.9),
  place("lva", "Latvia", 24.6, 56.9),
  place("lbn", "Lebanon", 35.9, 33.9),
  place("lso", "Lesotho", 28.2, -29.6),
  place("lbr", "Liberia", -9.4, 6.4),
  place("lby", "Libya", 17.2, 26.3),
  place("lie", "Liechtenstein", 9.5, 47.2),
  place("ltu", "Lithuania", 23.9, 55.2),
  place("lux", "Luxembourg", 6.1, 49.8),
  place("mdg", "Madagascar", 46.9, -18.8),
  place("mwi", "Malawi", 34.3, -13.3),
  place("mys", "Malaysia", 101.9, 4.2),
  place("mdv", "Maldives", 73.5, 3.2),
  place("mli", "Mali", -4, 17),
  place("mlt", "Malta", 14.4, 35.9),
  place("mhl", "Marshall Islands", 168, 7),
  place("mrt", "Mauritania", -10.9, 21.0),
  place("mus", "Mauritius", 57.5, -20.3),
  place("mex", "Mexico", -102.5, 23.6),
  place("fsm", "Micronesia", 150, 6.9),
  place("mda", "Moldova", 28.4, 47.4),
  place("mco", "Monaco", 7.4, 43.7),
  place("mng", "Mongolia", 103.8, 46.9),
  place("mne", "Montenegro", 19.3, 42.7),
  place("mar", "Morocco", -7.1, 31.8),
  place("moz", "Mozambique", 35.5, -18.7),
  place("mmr", "Myanmar", 96, 21, ["\\bMyanmar\\b", "\\bBurma\\b"]),
  place("nam", "Namibia", 17.1, -22.9),
  place("nru", "Nauru", 166.9, -0.5),
  place("npl", "Nepal", 84.1, 28.4),
  place("nld", "Netherlands", 5.3, 52.2),
  place("nzl", "New Zealand", 172, -41),
  place("nic", "Nicaragua", -85.2, 12.9),
  place("ner", "Niger", 8.1, 17.6),
  place("nga", "Nigeria", 8.7, 9.1),
  place("mkd", "North Macedonia", 21.7, 41.6),
  place("nor", "Norway", 8.5, 60.5),
  place("omn", "Oman", 55.9, 21.5),
  place("pak", "Pakistan", 69.3, 30.4),
  place("plw", "Palau", 134.6, 7.5),
  place("pse", "Palestine", 35.2, 31.9, [
    "\\bGaza\\b",
    "\\boccupied Palestinian territory\\b",
    "\\boPt\\b",
    "\\bWest Bank\\b",
    "\\bPalestine\\b",
    "\\bPalestinian\\b",
  ]),
  place("pan", "Panama", -80.8, 8.5),
  place("png", "Papua New Guinea", 143.9, -6.3),
  place("pry", "Paraguay", -58.4, -23.4),
  place("per", "Peru", -75.0, -9.2),
  place("phl", "Philippines", 121.8, 12.9),
  place("pol", "Poland", 19.1, 52.1),
  place("prt", "Portugal", -8.2, 39.4),
  place("qat", "Qatar", 51.2, 25.4),
  place("rou", "Romania", 24.9, 45.9),
  place("rus", "Russia", 90, 61.5),
  place("rwa", "Rwanda", 29.9, -1.9),
  place("kna", "Saint Kitts and Nevis", -62.7, 17.3),
  place("lca", "Saint Lucia", -60.9, 13.9),
  place("vct", "Saint Vincent and the Grenadines", -61.2, 13.2),
  place("wsm", "Samoa", -172.1, -13.8),
  place("smr", "San Marino", 12.4, 43.9),
  place("stp", "Sao Tome and Principe", 6.6, 0.2),
  place("sau", "Saudi Arabia", 45.1, 24.0),
  place("sen", "Senegal", -14.5, 14.5),
  place("srb", "Serbia", 21.0, 44.0),
  place("syc", "Seychelles", 55.5, -4.7),
  place("sle", "Sierra Leone", -11.8, 8.5),
  place("sgp", "Singapore", 103.8, 1.35),
  place("svk", "Slovakia", 19.7, 48.7),
  place("svn", "Slovenia", 14.8, 46.1),
  place("slb", "Solomon Islands", 160, -9.6),
  place("som", "Somalia", 46, 5.5),
  place("zaf", "South Africa", 24.7, -30.6),
  // Exclude when preceded by "South " so bare "Sudan" never also claims
  // South Sudan mentions.
  place("sdn", "Sudan", 30, 15, ["(?<!South )\\bSudan\\b"]),
  place("ssd", "South Sudan", 30.5, 6.9),
  place("esp", "Spain", -3.7, 40.5),
  place("lka", "Sri Lanka", 80.8, 7.9),
  place("sur", "Suriname", -56.0, 3.9),
  place("swe", "Sweden", 16.5, 62.2),
  place("che", "Switzerland", 8.2, 46.8),
  place("syr", "Syria", 38.5, 35.0, ["\\bSyria\\b", "\\bSyrian Arab Republic\\b"]),
  place("tjk", "Tajikistan", 71.3, 38.9),
  place("tza", "Tanzania", 34.9, -6.4),
  place("tha", "Thailand", 101.0, 15.9),
  place("tls", "Timor-Leste", 125.7, -8.6),
  place("tgo", "Togo", 0.9, 8.6),
  place("ton", "Tonga", -175.2, -21.2),
  place("tto", "Trinidad and Tobago", -61.2, 10.7),
  place("tun", "Tunisia", 9.5, 33.9),
  place("tur", "Turkey", 35.2, 39.0, ["\\bTurkey\\b", "\\bTürkiye\\b"]),
  place("tkm", "Turkmenistan", 59.6, 38.9),
  place("tuv", "Tuvalu", 179.2, -8.5),
  place("uga", "Uganda", 32.3, 1.4),
  place("ukr", "Ukraine", 31, 49),
  place("are", "United Arab Emirates", 54.3, 24.0),
  place("gbr", "United Kingdom", -1.5, 52.4),
  place("usa", "United States", -98.6, 39.8, ["\\bUnited States\\b", "\\bUSA\\b"]),
  place("ury", "Uruguay", -55.8, -32.5),
  place("uzb", "Uzbekistan", 64.6, 41.4),
  place("vut", "Vanuatu", 166.9, -15.4),
  place("ven", "Venezuela", -66.9, 6.4),
  place("vnm", "Vietnam", 108.3, 14.1),
  place("yem", "Yemen", 48, 15),
  place("zmb", "Zambia", 27.8, -13.1),
  place("zwe", "Zimbabwe", 29.2, -19.0),
];

const COUNTRY_BY_ID = new Map(COUNTRIES.map((c) => [c.id, c]));
// ISO3 speaker-affiliation code -> country id, for resolving who's speaking
// (a different question from which country a statement is *about* — see
// detectCountries). Built from the same gazetteer entries where the id
// already is the lowercased ISO3 code.
const ISO3_TO_COUNTRY_ID = new Map(COUNTRIES.map((c) => [c.id.toUpperCase(), c.id]));

function detectCountries(text) {
  if (!text) return [];
  return COUNTRIES.filter((c) => c.regex.test(text));
}

function speakerCountryName(affiliation, fallback) {
  if (!affiliation) return fallback;
  const id = ISO3_TO_COUNTRY_ID.get(affiliation.toUpperCase());
  if (id) return COUNTRY_BY_ID.get(id).name;
  return affiliation; // org code (OCHA, UNFPA, UN, ...) or unrecognized — show as-is
}

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
  const place = affiliation ? speakerCountryName(affiliation, affiliation) : null;
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
    title: meetingItem.title || "",
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

function newBucket(country) {
  return {
    id: country.id,
    name: country.name,
    lon: country.lon,
    lat: country.lat,
    all: [],
    briefings: [],
    leadership: [],
    sc: [],
    onOcha: [],
  };
}

// See the earlier caution in README.md: no automated "supportive/critical"
// stance here on purpose — that's an editorial call, not an extraction task.
async function main() {
  console.log(`[ingest] starting ${new Date().toISOString()}`);

  const from = dateNDaysAgo(LOOKBACK_DAYS);
  const byPageUrl = new Map();
  let anyQuerySucceeded = false;

  for (const query of OCHA_IDENTITY_QUERIES) {
    try {
      const results = await searchStatements(query, { from });
      anyQuerySucceeded = true;
      for (const m of results) {
        const key = m.pageUrl || `${m.date}|${m.speaker}|${m.text}`;
        if (!byPageUrl.has(key)) byPageUrl.set(key, m);
      }
    } catch (err) {
      console.error(`[ingest] query "${query}" failed:`, err.message);
    }
  }

  if (!anyQuerySucceeded) {
    console.error("[ingest] fatal: every OCHA-identity query failed — leaving existing data/crises.json untouched");
    process.exit(1);
  }

  const matches = Array.from(byPageUrl.values());
  const byCountry = new Map();

  for (const m of matches) {
    let subjects = detectCountries(m.text);
    if (subjects.length === 0) subjects = detectCountries(m.title);
    if (subjects.length === 0) continue;

    const isOcha = isLeadershipStatement(m);

    for (const subject of subjects) {
      if (!byCountry.has(subject.id)) byCountry.set(subject.id, newBucket(subject));
      const bucket = byCountry.get(subject.id);
      bucket.all.push(m);

      if (isOcha) {
        if (m.isBriefing) bucket.briefings.push(m);
        else if (m.category === "Security Council") bucket.sc.push(m);
        else bucket.leadership.push(m);
      } else {
        bucket.onOcha.push({
          date: m.date,
          country: speakerCountryName(m.speakerAffiliation, m.speaker),
          text: m.text,
          t: m.t,
          pageUrl: m.pageUrl,
        });
      }
    }
  }

  if (byCountry.size === 0) {
    if (totalNormalizedMatches === 0) {
      console.error(
        "[ingest] every OCHA-identity query returned 0 normalized matches — see the [ingest][warn] block " +
          "above for the raw response shape. Leaving existing data/crises.json untouched."
      );
    } else {
      console.error(
        `[ingest] ${matches.length} statements matched (from ${totalNormalizedMatches} raw, before de-duplication) ` +
          "but none could be attributed to a country (no gazetteer match in statement text or meeting title). " +
          "Leaving existing data/crises.json untouched."
      );
    }
    process.exit(1);
  }

  const all = Array.from(byCountry.values());
  const recentCounts = all.map((c) => c.all.filter((m) => m.date >= dateNDaysAgo(30)).length);
  const avgRecent = recentCounts.reduce((a, b) => a + b, 0) / (recentCounts.length || 1);
  // "Elevated" is relative to this run's own distribution rather than a fixed
  // magic number: absolute OCHA-related volume per country is a much smaller
  // scale than the old "anyone mentions this crisis name" volume was, and a
  // fixed threshold tuned for one scale silently breaks when the scale
  // changes. Needs at least a handful of events too, so a quiet run with
  // uniformly low activity doesn't mark everything "elevated" just for being
  // above its own (tiny) average.
  const elevatedThreshold = Math.max(avgRecent, 3);

  const crises = all
    .sort((a, b) => {
      const bv = b.all.filter((m) => m.date >= dateNDaysAgo(30)).length;
      const av = a.all.filter((m) => m.date >= dateNDaysAgo(30)).length;
      return bv - av;
    })
    .slice(0, MAX_CRISES_SHOWN)
    .map((c) => {
      const recent30 = c.all.filter((m) => m.date >= dateNDaysAgo(30));
      const trend = weeklyTrend(c.all, 12);
      return {
        id: c.id,
        name: c.name,
        lon: c.lon,
        lat: c.lat,
        volume: recent30.length,
        level: recent30.length >= elevatedThreshold ? "elevated" : "standard",
        trend,
        top: (c.leadership[0] || c.sc[0] || c.briefings[0] || c.all[0] || {}).text || "",
        briefings: c.briefings.slice(0, 40).map(stripInternal),
        leadership: c.leadership.slice(0, 40).map(stripInternal),
        sc: c.sc.slice(0, 40).map(stripInternal),
        onOcha: c.onOcha,
      };
    });

  const dataQuality = "ok";
  const output = { generatedAt: new Date().toISOString(), dataQuality, crises };
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`[ingest] wrote ${crises.length} crises (of ${byCountry.size} detected; dataQuality: ${dataQuality}) to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("[ingest] fatal:", err);
  process.exit(1);
});
