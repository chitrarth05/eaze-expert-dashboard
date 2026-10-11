import { google } from "googleapis";
import fs from "fs";

/**
 * Google service account credentials.
 *
 * Preferred: GOOGLE_CREDENTIALS_JSON — the whole key pasted into one env
 * var. That keeps every setting in a single Devtron secret mounted as
 * Environment Variables, with no volume mount anywhere. Worth doing because
 * a volume mounted at /app REPLACES the working directory rather than
 * merging into it, which silently deletes package.json and node_modules at
 * runtime — a confusing crash that looks nothing like a config mistake.
 *
 * Falls back to reading a file so local development (and the older
 * volume-mount setup) keeps working unchanged.
 */
function loadCredentials() {
  const raw = process.env.GOOGLE_CREDENTIALS_JSON;

  if (raw && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        'GOOGLE_CREDENTIALS_JSON is set but is not valid JSON. Paste the entire ' +
        'service-account key as a single line, starting with { and ending with }. ' +
        `Parser said: ${err.message}`
      );
    }
  }

  const path = process.env.GOOGLE_CREDENTIALS_PATH || './google-credentials.json';
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `No Google credentials found. Set GOOGLE_CREDENTIALS_JSON (preferred), or ` +
      `place the key file at ${path}. Underlying error: ${err.message}`
    );
  }
}

const credentials = loadCredentials();

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({
  version: "v4",
  auth,
});

const SPREADSHEET_ID = "14L3rDJMt8_BN9AXPXzc3qA_Cp5JurvMIzCOzCI5p02I";

// Change this to the actual tab name in your Google Sheet
const SHEET_NAME = "BQ Raw Output";

/**
 * Sheet reads are cached in-process.
 *
 * Without this every dashboard load pulled the whole A:AZ range, and
 * resolveTier can ask up to three times per request (mobile, then two id
 * fallbacks). At ~3 reads per page view the Sheets per-user read quota
 * (60/min by default) is exhausted by roughly 20 loads a minute, and a 429
 * means every buddy silently drops to "Base".
 *
 * Tiers only change at the weekly reset, so a long TTL costs nothing.
 * Per-process, like the Redash cache — another reason to stay on one replica
 * until this moves to Redis.
 */
const TIERS_TTL_MS = Number(process.env.TIERS_CACHE_TTL_SECONDS || 3600) * 1000;
let warnedMissing = false;   // log the schema warning once, not per refresh
let rowCache = null;      // { rows, expires }
let rowInflight = null;   // dedupes concurrent misses

async function fetchTierRows() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:BZ`,
  });

  const rows = response.data.values || [];

  if (rows.length < 2) return [];

  const headers = rows[0];

  // If Apps Script writes a fixed column list, new fields never arrive and
  // the dashboard degrades silently — no error, every expert just shows as
  // Base with no tier and no progress bar. Fail loudly in the log instead.
  const REQUIRED = [
    'payout_bucket', 'metric_tier', 'quality_standing', 'range_end_ist', 'mobile_no',
  ];
  const missing = REQUIRED.filter((c) => !headers.includes(c));
  if (missing.length && !warnedMissing) {
    warnedMissing = true;
    console.error(
      `[sheet] "${SHEET_NAME}" is missing expected column(s): ${missing.join(', ')}. ` +
      'The Apps Script export needs updating — until then current tiers and the ' +
      '"not confirmed in review" line will not work correctly.'
    );
  }

  return rows.slice(1).map((values) => {
    const row = {};

    headers.forEach((header, index) => {
  row[header] = values[index] ?? "";
});

row.mobile_10 = String(row.mobile_no || "").replace(/\D/g, "").slice(-10);

    return row;
  });
}

export async function getTierRows() {
  const now = Date.now();
  if (rowCache && rowCache.expires > now) return rowCache.rows;
  if (rowInflight) return rowInflight;

  rowInflight = fetchTierRows()
    .then((rows) => {
      rowCache = { rows, expires: Date.now() + TIERS_TTL_MS };
      return rows;
    })
    .catch((err) => {
      // Serve stale rather than dropping everyone to Base on a transient
      // Sheets error. Only fail outright if we have nothing at all.
      if (rowCache) return rowCache.rows;
      throw err;
    })
    .finally(() => { rowInflight = null; });

  return rowInflight;
}

export function clearTierCache() {
  rowCache = null;
  tierIndex = null;
}

/**
 * Tier indexes, memoised per cached row set. Replaces three linear scans of
 * the whole sheet per dashboard load. Separate maps per id column so the
 * fallback order (mobile, then expert_id, then profile/user id) is preserved
 * exactly rather than collapsing into one map where a collision could match
 * the wrong buddy.
 */
let tierIndex = null;

async function indexes() {
  const rows = await getTierRows();
  if (tierIndex && tierIndex.rows === rows) return tierIndex;

  const byMobile = new Map();
  const byExpertId = new Map();
  const byProfileId = new Map();
  const byUserId = new Map();
  const put = (map, k, row) => {
    const key = String(k ?? '').trim();
    if (key && !map.has(key)) map.set(key, row);
  };
  for (const row of rows) {
    put(byMobile, row.mobile_10, row);
    put(byExpertId, row.expert_id, row);
    put(byProfileId, row.expert_profile_id, row);
    put(byUserId, row.user_id, row);
  }

  tierIndex = { rows, byMobile, byExpertId, byProfileId, byUserId };
  return tierIndex;
}

/**
 * Tier lookup by id. The sheet's id column is `expert_id`; we also accept
 * `expert_profile_id` / `user_id` headers since the VP output has been
 * renamed before. Matching is string-based because Sheets returns strings.
 */
export async function getTierById(id) {
  const want = String(id ?? '').trim();
  if (!want) return undefined;

  const ix = await indexes();
  return ix.byExpertId.get(want) || ix.byProfileId.get(want) || ix.byUserId.get(want);
}

export async function getTierByMobile(mobile) {
  const want = String(mobile ?? '').trim();
  if (!want) return undefined;

  return (await indexes()).byMobile.get(want);
}