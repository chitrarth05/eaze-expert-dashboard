import { google } from "googleapis";
import fs from "fs";

const credentials = JSON.parse(
  fs.readFileSync("./google-credentials.json", "utf8")
);

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
let rowCache = null;      // { rows, expires }
let rowInflight = null;   // dedupes concurrent misses

async function fetchTierRows() {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:AZ`,
  });

  const rows = response.data.values || [];

  if (rows.length < 2) return [];

  const headers = rows[0];

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
}

/**
 * Tier lookup by id. The sheet's id column is `expert_id`; we also accept
 * `expert_profile_id` / `user_id` headers since the VP output has been
 * renamed before. Matching is string-based because Sheets returns strings.
 */
export async function getTierById(id) {
  const want = String(id ?? '').trim();
  if (!want) return undefined;

  const rows = await getTierRows();
  return rows.find((row) => {
    const candidates = [row.expert_id, row.expert_profile_id, row.user_id];
    return candidates.some((c) => String(c ?? '').trim() === want);
  });
}

export async function getTierByMobile(mobile) {
  const rows = await getTierRows();

  return rows.find(
    (row) => String(row.mobile_10).trim() === String(mobile).trim()
  );
}