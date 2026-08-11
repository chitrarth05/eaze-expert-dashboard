/**
 * redash.js — pulls both source queries and caches them in memory.
 *
 * Two queries feed this dashboard:
 *   1. METRICS  — one row per expert: response split, hours, quality, the
 *                 within-language signals, and the reset clock.
 *   2. TIERS    — the Variable Pricing ranking output (already on a schedule).
 *                 We only read the tier from it; nothing is recomputed here.
 *
 * They are joined on mobile_10 (last 10 digits). Both queries emit that column
 * because raw mobile_no formatting is inconsistent (+91, spaces, leading zero)
 * and joining on it directly drops experts silently.
 *
 * Caching: each query result is held for a TTL so a burst of expert logins
 * hits Redash once. Redash re-runs are slow, so we ask for cached results
 * (no max_age) rather than forcing a refresh on every poll.
 */

const BASE_URL      = () => (process.env.REDASH_BASE_URL || '').replace(/\/$/, '');
const API_KEY       = () => process.env.REDASH_API_KEY || '';
const METRICS_QUERY = () => process.env.REDASH_METRICS_QUERY_ID || '';
const TIERS_QUERY   = () => process.env.REDASH_TIERS_QUERY_ID || '';

const METRICS_TTL_MS = Number(process.env.METRICS_CACHE_TTL_SECONDS || 900) * 1000;   // 15 min
const TIERS_TTL_MS   = Number(process.env.TIERS_CACHE_TTL_SECONDS   || 3600) * 1000;  // 1 hour
const POLL_INTERVAL  = Number(process.env.REDASH_POLL_INTERVAL_MS   || 500);
const POLL_MAX_TRIES = Number(process.env.REDASH_POLL_MAX_TRIES     || 60);

const cache = new Map(); // key -> { expiresAt, rows }
const inflight = new Map(); // key -> Promise, so concurrent misses share one fetch

export function normalizeMobile(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))  return digits.slice(1);
  return digits.slice(-10);
}

function headers() {
  return { Authorization: `Key ${API_KEY()}`, 'Content-Type': 'application/json' };
}

async function pollJob(jobId) {
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const res  = await fetch(`${BASE_URL()}/api/jobs/${jobId}`, { headers: headers() });
    const data = await res.json();
    const job  = data.job || {};
    if (job.status === 3) return job.query_result_id;
    if (job.status === 4) throw new Error(job.error || 'Redash job failed');
  }
  throw new Error('Redash job polling timed out');
}

async function fetchQueryRows(queryId) {
  if (!BASE_URL() || !API_KEY() || !queryId) {
    throw new Error('Redash is not configured (REDASH_BASE_URL / REDASH_API_KEY / query id)');
  }

  // No max_age: take whatever Redash already has cached. Forcing a refresh on
  // every expert login would hammer BigQuery and add ~30s to page load.
  const res = await fetch(`${BASE_URL()}/api/queries/${queryId}/results`, {
    method: 'POST', headers: headers(), body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Redash ${res.status} on query ${queryId}`);
  const data = await res.json();

  if (data.query_result) return data.query_result.data.rows;

  if (data.job?.id) {
    const resultId = await pollJob(data.job.id);
    const rRes  = await fetch(`${BASE_URL()}/api/query_results/${resultId}.json`, { headers: headers() });
    const rData = await rRes.json();
    return rData.query_result.data.rows;
  }

  throw new Error(`Unexpected Redash response for query ${queryId}`);
}

async function cachedRows(key, queryId, ttlMs) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.rows;

  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    try {
      const rows = await fetchQueryRows(queryId);
      cache.set(key, { expiresAt: Date.now() + ttlMs, rows });
      return rows;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
export async function getMetricsRows() {
  const rows = await cachedRows('metrics', METRICS_QUERY(), METRICS_TTL_MS);

  return rows.map((row) => ({
    ...row,
    daily: parseJsonArray(row.daily),
    signals: parseJsonArray(row.signals),
  }));
}

export async function getTierRows() {
  return cachedRows('tiers', TIERS_QUERY(), TIERS_TTL_MS);
}

/** Tier lookup keyed by normalized mobile. Missing = not ranked this phase. */
export async function getTierByMobile() {
  const rows = await getTierRows();
  const map = new Map();
  for (const r of rows) {
    const key = normalizeMobile(r.mobile_10 ?? r.mobile_no);
    if (key.length === 10) map.set(key, r);
  }
  return map;
}

/** Metrics lookup keyed by normalized mobile. */
export async function getMetricsByMobile() {
  const rows = await getMetricsRows();
  const map = new Map();
  for (const r of rows) {
    const key = normalizeMobile(r.mobile_10 ?? r.mobile_no);
    if (key.length === 10) map.set(key, r);
  }
  return map;
}

/**
 * Metrics lookup keyed by expert_user_id (the auth user id the app knows).
 * Kept separate from the mobile index so the two entry paths can't collide:
 * a user_id is never treated as a mobile or vice versa.
 */
export async function getMetricsByUserId() {
  const rows = await getMetricsRows();
  const map = new Map();
  for (const r of rows) {
    const key = normalizeId(r.expert_user_id);
    if (key) map.set(key, r);
  }
  return map;
}

/** Ids arrive as numbers from BigQuery and strings from Sheets. */
export function normalizeId(value) {
  const s = String(value ?? '').trim();
  return /^\d+$/.test(s) ? s : '';
}

export function cacheStatus() {
  const out = {};
  for (const [k, v] of cache.entries()) {
    out[k] = { rows: v.rows.length, expiresInSeconds: Math.max(0, Math.round((v.expiresAt - Date.now()) / 1000)) };
  }
  return out;
}

export function clearCache() {
  cache.clear();
}
