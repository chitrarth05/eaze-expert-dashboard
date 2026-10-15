/**
 * dashboard-service.js — joins the two Redash queries into the payload the
 * webview renders.
 *
 * Nothing is scored here. Tier comes from the Variable Pricing query; every
 * other number and the directional signals come from the metrics query. This
 * layer only reshapes and applies presentation rules.
 */

import {
  getMetricsByMobile,
  normalizeMobile
} from "./redash.js";

import {
  getTierByMobile
} from "./google-sheet.js";

const TIER_LADDER = [
  { name: 'Diamond', label: 'Diamond', maxTop: 10 },
  { name: 'Gold',    label: 'Gold',    maxTop: 25 },
  { name: 'Silver',  label: 'Silver',  maxTop: 40 },
  { name: 'Base',    label: 'Base',    maxTop: 100 },
];

/** Resolve a mobile to an expert row. Returns null if they aren't in the pool. */
export async function lookupExpert(mobileNumber) {
  const key = normalizeMobile(mobileNumber);
  if (key.length !== 10) return null;
  const metrics = await getMetricsByMobile();
  return metrics.get(key) || null;
}

/**
 * Marker position on the tier ladder.
 *
 * Segment widths are floored at a minimum so the longest label still fits,
 * then the expert's percentile is mapped through that same distorted scale.
 * Without the second step the marker drifts out of its own tier.
 */
function ladderGeometry(topPercent) {
  const MIN_W = 21;
  const asc = [...TIER_LADDER].sort((a, b) => a.maxTop - b.maxTop);
  let lo = 0;
  const bounds = asc.map((t) => { const s = { ...t, lo, hi: t.maxTop }; lo = t.maxTop; return s; });
  let widths = bounds.map((s) => Math.max(s.hi - s.lo, MIN_W));
  const sum = widths.reduce((a, b) => a + b, 0);
  widths = widths.map((w) => (w / sum) * 100);

  const segs = bounds.map((s, i) => ({ ...s, w: widths[i] })).reverse(); // best on the right

  let markerPos = 0, acc = 0;
  if (topPercent != null) {
    for (const s of segs) {
      if (topPercent <= s.hi && topPercent > s.lo) {
        markerPos = acc + ((s.hi - topPercent) / Math.max(s.hi - s.lo, 1)) * s.w;
        break;
      }
      acc += s.w;
    }
  }
  return { segments: segs.map((s) => ({ name: s.name, label: s.label, w: Number(s.w.toFixed(3)) })), markerPos: Number(markerPos.toFixed(3)) };
}

const IST_OFFSET = '+05:30';
const WEEK_MS    = 7 * 24 * 60 * 60 * 1000;

/**
 * Countdown to the weekly tier reset, derived at REQUEST time.
 *
 * The query also ships hours_to_reset / days_to_reset, but those are frozen at
 * query-execution time. Redash refreshes on a schedule (daily), so trusting
 * them would mean the countdown only moves once a day — and the "< 24 hours"
 * branch would show an hour figure that is up to a day out of date, sometimes
 * counting down to a reset that has already happened.
 *
 * next_reset_ist is an absolute instant, so it survives caching. We only have
 * to roll it forward if the result was cached from before the last reset,
 * which makes this self-correcting no matter how stale the query result is.
 */
function resetClock(nextResetIst) {
  const empty = { nextResetAt: null, hoursToReset: null, daysToReset: null };
  if (!nextResetIst) return empty;

  const iso = String(nextResetIst).slice(0, 19).replace(' ', 'T');
  let target = Date.parse(`${iso}${IST_OFFSET}`);
  if (Number.isNaN(target)) return empty;

  const now = Date.now();
  while (target <= now) target += WEEK_MS;

  const hours = (target - now) / 3600000;
  return {
    nextResetAt: new Date(target).toISOString(),
    hoursToReset: Math.floor(hours),
    daysToReset: Math.ceil(hours / 24),
  };
}

const SIGNAL_TITLES = {
  pickup_rate:        'Pickup Rate',
  dnp_rate:           'Missed Calls',
  rejection_rate:     'Rejected Calls',
  active_hours:       'Active Hours',
  audio_active_hours: 'Audio Active Hours',
  talktime:           'Talktime',
  avg_call_duration:  'Avg Call Duration',
  audio_contribution: 'Audio Talktime',
  short_calls:        'Calls Under 10s',
};

function nudgeFor(tier) {
  switch (tier) {
    case 'Diamond': return null;
    case 'Gold':    return 'Push to Diamond — you\u2019re closer than you think.';
    case 'Silver':  return 'Gold is within reach. Keep your consistency up.';
    default:        return 'Keep your numbers steady to move up a tier.';
  }
}

/** Pull the day-wise series out of the BigQuery ARRAY<STRUCT> column. */
function normalizeDaily(daily) {
  if (!Array.isArray(daily)) return [];
  return daily.map((d) => ({
    day: d.day_ist,
    wasActive: d.was_active === true || d.was_active === 'true',
    pickupPct: numOrNull(d.pickup_pct),
    rejectedPct: numOrNull(d.rejected_pct),
    dnpPct: numOrNull(d.dnp_pct),
    activeHours: numOrNull(d.active_hours),
    audioActiveHours: numOrNull(d.audio_active_hours),
    avgCallDurationMins: numOrNull(d.avg_call_duration_mins),
    audioContributionPct: numOrNull(d.audio_contribution_pct),
    shortCallPct: numOrNull(d.short_call_pct),
  }));
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
}

/** Build the full payload the webview renders. */
export async function buildDashboard(mobileNumber) {
  const key = normalizeMobile(mobileNumber);
const metricsMap = await getMetricsByMobile();
const t = await getTierByMobile(key);

  const m = metricsMap.get(key);
  if (!m) return null;

  // Not in the VP output => excluded from the eligibility pool or below the
  // cohort floor. Show Base rather than an error, and never say why.
  const tier = t?.payout_bucket || 'Base';
const topPercent = null;
const { segments } = ladderGeometry(topPercent);

const tierCenters = {
  Base: 24.4,
  Silver: 57.3,
  Gold: 74.4,
  Diamond: 91.5,
};

const markerPos = tierCenters[tier] ?? 24.4;

  const daily = normalizeDaily(m.daily);
  const labels = daily.map((d) => shortDate(d.day));

  const hasActivity = m.has_activity_7d === true || m.has_activity_7d === 'true' || Number(m.active_days_7d) > 0;

  // Signals arrive worst-first from SQL. Only surface "needs work" text; the
  // rest render as a quiet check. Suppressed when the language pool is too
  // thin for a percentile to mean anything.
  const signalsReliable = m.signals_reliable === true || m.signals_reliable === 'true';
  const signals = Array.isArray(m.signals)
  ? m.signals.map((s) => ({
      metric: s.metric,
      // Display copy lives here, not in SQL. The query still ships a `title`,
      // but keying off `metric` means a wording change is a deploy, not a
      // Redash edit — and a stale query can't put old copy on screen.
      title: SIGNAL_TITLES[s.metric] || s.title,
      signal: s.signal,
      label: s.label
    }))
  : [];

  const reset = resetClock(m.next_reset_ist);

  return {
    expert: {
      id: m.expert_profile_id,
      name: m.expert_name,
      locale: m.locale || 'en',
      onboardedDate: m.onboarded_date_ist,
    },
    window: {
      // The window is 7 COMPLETE days ending yesterday — today is excluded on
      // purpose, so the UI has to say so or the expert will read a missing
      // day as lost work.
      start: m.window_start_ist,
      end: m.window_end_ist,
      days: numOrNull(m.window_days),
      startLabel: shortDate(m.window_start_ist),
      endLabel: shortDate(m.window_end_ist),
      dataThrough: m.data_through_ist || m.window_end_ist,
      dataThroughLabel: shortDate(m.data_through_ist || m.window_end_ist),
      pendingDayLabel: shortDate(m.pending_day_ist),
      labels,
    },
    reset,
    earningTier: {
      tier,
      ranked: Boolean(t),
      topPercent,
      segments,
      markerPos,
      nudge: nudgeFor(tier),
      signals,
      signalsReliable,
    },
    activity: {
      hasActivity,
      activeDays: numOrNull(m.active_days_7d) ?? 0,
    },
    callResponse: {
      requests: numOrNull(m.response_requests) ?? 0,
      pickupPct: numOrNull(m.pickup_pct),
      rejectedPct: numOrNull(m.rejected_pct),
      dnpPct: numOrNull(m.dnp_pct),
      daily: {
        pickup: daily.map((d) => d.pickupPct),
        rejected: daily.map((d) => d.rejectedPct),
        dnp: daily.map((d) => d.dnpPct),
      },
    },
    hours: {
      total: numOrNull(m.active_hours) ?? 0,
      audio: numOrNull(m.audio_active_hours) ?? 0,
      other: numOrNull(m.other_active_hours) ?? 0,
      dailyTotal: daily.map((d) => d.activeHours),
      dailyAudio: daily.map((d) => d.audioActiveHours),
    },
    callQuality: {
      finishedCalls: numOrNull(m.finished_calls) ?? 0,
      subMetrics: [
        {
          key: 'avg_call_duration', title: 'Avg Call Duration', unit: 'm',
          directionGood: 'higher', value: numOrNull(m.avg_call_duration_mins),
          values: daily.map((d) => d.avgCallDurationMins),
        },
        {
          key: 'audio_contribution', title: 'Audio Talktime', unit: '%',
          directionGood: 'higher', value: numOrNull(m.audio_contribution_pct),
          values: daily.map((d) => d.audioContributionPct),
        },
        {
          key: 'short_calls', title: 'Calls under 10s', unit: '%',
          directionGood: 'lower', value: numOrNull(m.short_call_pct),
          values: daily.map((d) => d.shortCallPct),
        },
      ],
    },
  };
}
