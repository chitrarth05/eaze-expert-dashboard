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
  'expert_profile_id', 'expert_name', 'mobile_10', 'locale',
  'has_activity_7d', 'response_requests', 'pickup_pct', 'rejected_pct', 'dnp_pct',
  'active_hours', 'audio_active_hours', 'other_active_hours',
  'avg_call_duration_mins', 'audio_contribution_pct', 'short_call_pct',
  'next_reset_ist', 'hours_to_reset', 'days_to_reset',
  'signals', 'signals_reliable', 'daily',
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

  pass &= check('daily array is 7 days', Array.isArray(sample.daily) && sample.daily.length === 7,
    `got ${Array.isArray(sample.daily) ? sample.daily.length : typeof sample.daily}`);
  pass &= check('signals array present', Array.isArray(sample.signals),
    Array.isArray(sample.signals) ? `${sample.signals.length} signals` : typeof sample.signals);

  console.log('\nTiers query (Variable Pricing)');
  const tiers = await getTierRows();
  pass &= check('rows returned', tiers.length > 0, `${tiers.length} ranked experts`);
  const tSample = tiers[0] || {};
  pass &= check('has payout_bucket', 'payout_bucket' in tSample);
  pass &= check('has final_prank', 'final_prank' in tSample);
  pass &= check('has mobile_10', 'mobile_10' in tSample,
    'mobile_10' in tSample ? '' : 'add it to the VP query SELECT — the join needs it');

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

  const inactive = metrics.filter((r) => !(r.has_activity_7d === true || r.has_activity_7d === 'true')).length;
  console.log(`  experts with no activity in 7d: ${inactive}/${metrics.length}`);

  const unreliable = metrics.filter((r) => !(r.signals_reliable === true || r.signals_reliable === 'true')).length;
  console.log(`  experts in language pools too small to signal: ${unreliable}/${metrics.length}`);

  console.log(pass ? '\nAll checks passed.\n' : '\nSome checks failed — see above.\n');
  process.exit(pass ? 0 : 1);
};

run().catch((err) => {
  console.error('\nRedash test failed:', err.message);
  process.exit(1);
});
