/**
 * test-redash.js — verifies both queries are reachable and that the join key
 * actually lines up before you deploy.
 *
 *   npm run redash:test
 */

import dotenv from 'dotenv';
import { getMetricsRows, normalizeMobile } from "./redash.js";
import { getTierRows } from "./google-sheet.js";

dotenv.config();

const REQUIRED_METRIC_COLS = [
  'expert_profile_id', 'expert_name', 'mobile_10', 'locale', 'language_id',
  'window_start_ist', 'window_end_ist', 'week_end_ist', 'window_days',
  'is_week_final', 'days_left_in_week', 'has_activity_week', 'active_days_week',
  'response_requests', 'connected_calls', 'pickup_pct', 'rejected_pct', 'dnp_pct',
  'active_hours', 'audio_active_hours', 'other_active_hours',
  'audio_contribution_pct',
  'gate_pur_pct', 'gate_talktime_mins',
  'week_tier_rank', 'tier_targets',
  'next_reset_ist', 'hours_to_reset', 'days_to_reset', 'daily',
];

function check(label, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ' — ' + detail : ''}`);
  return ok;
}

const run = async () => {
  let pass = true;

  console.log('\nMetrics query');
  const metrics = await getMetricsRows();
  pass &= check('rows returned', metrics.length > 0, `${metrics.length} experts`);

  const sample = metrics[0] || {};
  const missing = REQUIRED_METRIC_COLS.filter((c) => !(c in sample));
  pass &= check('all expected columns present', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');

  const days = Number(sample.window_days);
  pass &= check('daily array matches the elapsed week',
    Array.isArray(sample.daily) && sample.daily.length === days,
    `got ${Array.isArray(sample.daily) ? sample.daily.length : typeof sample.daily}, window_days ${days}`);
  pass &= check('tier targets present', Array.isArray(sample.tier_targets) && sample.tier_targets.length > 0,
    Array.isArray(sample.tier_targets) ? `${sample.tier_targets.length} tiers` : typeof sample.tier_targets);

  console.log('\nTiers query (Variable Pricing)');
  const tiers = await getTierRows();
  pass &= check('rows returned', tiers.length > 0, `${tiers.length} ranked experts`);
  const tSample = tiers[0] || {};
  for (const col of ['payout_bucket', 'metric_tier', 'quality_standing', 'range_end_ist', 'mobile_10']) {
    pass &= check(`has ${col}`, col in tSample,
      col in tSample ? '' : 'the Apps Script export to "BQ Raw Output" needs this column');
  }

  console.log('\nJoin health');
  const metricKeys = new Set(metrics.map((r) => normalizeMobile(r.mobile_10 ?? r.mobile_no)).filter((k) => k.length === 10));
  const tierKeys   = tiers.map((r) => normalizeMobile(r.mobile_10 ?? r.mobile_no)).filter((k) => k.length === 10);
  const matched    = tierKeys.filter((k) => metricKeys.has(k)).length;

  pass &= check('metrics rows have a usable mobile', metricKeys.size > 0,
    `${metricKeys.size}/${metrics.length}`);
  pass &= check('ranked experts match a metrics row', matched > 0,
    `${matched}/${tierKeys.length} matched`);

  if (tierKeys.length && matched / tierKeys.length < 0.9) {
    console.log('\n  WARNING: under 90% of ranked experts matched. Usually means one');
    console.log('  side is emitting a differently-formatted mobile. Compare a few raw');
    console.log('  mobile_no values across both queries.');
  }

  const tiersSeen = [...new Set(tiers.map((r) => r.payout_bucket))];
  console.log(`\n  tiers present: ${tiersSeen.join(', ') || 'none'}`);

  const inactive = metrics.filter((r) => !(r.has_activity_week === true || r.has_activity_week === 'true')).length;
  console.log(`  experts with no activity this tier week: ${inactive}/${metrics.length}`);

  const byRank = {};
  for (const r of metrics) byRank[r.week_tier_rank] = (byRank[r.week_tier_rank] || 0) + 1;
  console.log(`  week-so-far tier ranks: ${JSON.stringify(byRank)}`);

  console.log(pass ? '\nAll checks passed.\n' : '\nSome checks failed — see above.\n');
  process.exit(pass ? 0 : 1);
};

run().catch((err) => {
  console.error('\nRedash test failed:', err.message);
  process.exit(1);
});
