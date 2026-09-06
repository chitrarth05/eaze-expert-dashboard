/**
 * dashboard-service.js — joins the two Redash queries into the payload the
 * webview renders.
 *
 * Nothing is scored here. Tier AND the tier signals both come from the
 * Variable Pricing query; the day-wise series and the raw display metrics come
 * from the metrics query. This layer only reshapes and applies presentation
 * rules.
 *
 * ── DISCLOSURE BOUNDARY (read before changing anything below) ──────────────
 * Three classes of information, and they are NOT interchangeable:
 *
 *   1. PUBLISHABLE — fixed rules that cannot move under an expert's feet.
 *      Only the volume gate qualifies (48 connected calls / 7d). Exact
 *      numbers are fine here because the number is the rule.
 *
 *   2. DIRECTIONAL — which metric to work on, and roughly how far along they
 *      are. Derived from percentiles but never printed as one. Safe because
 *      an ordering reveals nothing about anyone else's cutoff.
 *
 *   3. NEVER LEAVES THE SERVER — metric weights, raw percentile ranks,
 *      weighted_score, final_prank, tier cutoffs, and violation/exclusion
 *      status. WEIGHTS is deliberately module-private and must never be
 *      copied into the payload, not even as a sort key. Shipping a weight
 *      alongside a prank lets anyone reconstruct the whole scoring function.
 *
 * The reason for the split: an expert can satisfy every visible signal and
 * still not move tier, because tier is relative to their language pool and
 * because exclusions apply. Publishing "hit 90% pickup for Diamond" makes a
 * promise the system cannot keep. Ordering plus progress makes no such
 * promise while still answering "what do I do next".
 */

import {
  getMetricsByMobile,
  getMetricsByUserId,
  normalizeMobile,
  normalizeId
} from "./redash.js";

import {
  getTierByMobile,
  getTierById
} from "./google-sheet.js";

/**
 * The real ladder. Three tiers, no Gold.
 *
 * `maxTop` is the top-N% boundary: Diamond is final_prank >= 0.99 (top 1%),
 * Silver >= 0.88 (top 12%). This previously read Diamond/Gold/Silver/Base at
 * 10/25/40 — a structure the scoring query has never produced. Experts were
 * being shown a rung they could not reach.
 */
const TIER_LADDER = [
  { name: 'Diamond', label: 'Diamond', maxTop: 1   },
  { name: 'Silver',  label: 'Silver',  maxTop: 12  },
  { name: 'Base',    label: 'Base',    maxTop: 100 },
];

const NEXT_TIER = { Base: 'Silver', Silver: 'Diamond', Diamond: null };

/**
 * Scoring weights — PRIVATE. Class 3 above.
 *
 * Used only to rank which metric is the biggest lever for a given expert. The
 * weight itself, and the per-metric contribution computed from it, must never
 * appear in the returned payload.
 *
 * Must stay in sync with the weights in variable_pricing_ranking.sql. ACD is
 * absent on purpose: it is weighted 0.00 there, so surfacing it as something
 * to work on would send experts after a metric that cannot move their tier.
 */
// Must mirror the weights in variable_pricing_ranking.sql exactly. If these
// drift, "your biggest lever" points at the wrong metric — the dashboard
// would confidently send someone after something that barely scores.
// Retention and peak availability were removed from scoring; ACD restored.
const WEIGHTS = [
  { metric: 'avg_call_duration', prankField: 'acd_prank',        weight: 0.30 },
  { metric: 'pickup_rate',       prankField: 'pur_prank',        weight: 0.25 },
  { metric: 'short_calls',       prankField: 'short_call_prank', weight: 0.25 },
  { metric: 'talktime',          prankField: 'tt_prank',         weight: 0.20 },
];

/** Below this percentile in their own language pool, a metric is a drag. */
const NEEDS_WORK_BELOW = 40;

/** Never show more than this many "needs work" rows — a wall of red is noise. */
const MAX_NEEDS_WORK = 3;

/** A percentile across a handful of experts is meaningless. */
const MIN_POOL_FOR_SIGNALS = 20;

const SIGNAL_TITLES = {
  pickup_rate:        'Pickup Rate',
  dnp_rate:           'Missed Calls',
  rejection_rate:     'Rejected Calls',
  active_hours:       'Active Hours',
  audio_active_hours: 'Audio Active Hours',
  talktime:           'Talktime',
  avg_call_duration:  'Avg Call Duration',
  audio_contribution: 'Audio Talktime',
  retention_3d:       'Repeat Callers',
  short_calls:        'Calls Under 10s',
  peak_hours:         'Peak Hour Availability',
};

/** What to actually do about each metric. Plain, no numbers. */
const SIGNAL_ADVICE = {
  pickup_rate:   'Answer more of the calls that reach you.',
  retention_3d:  'People come back when a call goes well — that\u2019s what lifts this.',
  talktime:      'More time on calls across the week.',
  short_calls:   'Fewer calls ending in the first few seconds.',
  peak_hours:    'Be online between 9pm and 1am.',
};

/** Resolve a mobile to a metrics row. Null if they aren't in the pool. */
export async function lookupExpert(mobileNumber) {
  const key = normalizeMobile(mobileNumber);
  if (key.length !== 10) return null;
  const metrics = await getMetricsByMobile();
  return metrics.get(key) || null;
}

/** Resolve an expert_user_id to a metrics row. Null if not found. */
export async function lookupExpertByUserId(userId) {
  const key = normalizeId(userId);
  if (!key) return null;
  const metrics = await getMetricsByUserId();
  return metrics.get(key) || null;
}

/**
 * Tier row for a metrics row.
 *
 * Primary join is mobile_10, which is what the sheet and the metrics query
 * were built to share. The id join is a fallback: whichever entry path the
 * expert used, we already hold their full metrics row, so tier resolution
 * never depends on how they signed in.
 */
async function resolveTier(m) {
  const byMobile = await getTierByMobile(normalizeMobile(m.mobile_10 || m.mobile_no));
  if (byMobile) return byMobile;
  return (await getTierById(m.expert_user_id))
      || (await getTierById(m.expert_profile_id))
      || undefined;
}

/**
 * Marker position on the tier ladder.
 *
 * Segment widths are floored at a minimum so the longest label still fits,
 * then the expert's percentile is mapped through that same distorted scale.
 * Without the second step the marker drifts out of its own tier. The
 * distortion is load-bearing for privacy too: Diamond's true width is 1% of
 * the bar, so a marker inside a floored-to-21% segment is a far coarser
 * readout of standing than the underlying percentile.
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
  return {
    segments: segs.map((s) => ({ name: s.name, label: s.label, w: Number(s.w.toFixed(3)) })),
    markerPos: Number(markerPos.toFixed(3)),
  };
}

/** Centre of a named segment, for experts with no percentile to place. */
function segmentCentre(segments, tier) {
  let acc = 0;
  for (const s of segments) {
    if (s.name === tier) return Number((acc + s.w / 2).toFixed(3));
    acc += s.w;
  }
  return Number((100 - (segments[segments.length - 1]?.w ?? 20) / 2).toFixed(3));
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

/**
 * Build tier signals from the VP row's own percentile ranks.
 *
 * This replaces the old path, which took signals from the metrics query. Those
 * were ranked over a different window and over ALL active experts rather than
 * only those clearing the cohort gate, so an expert could see every signal
 * green and still not move — the two were answering different questions with
 * the same visual language. Sourcing from the VP row means a green signal and
 * the paid tier can no longer disagree within a week.
 *
 * Ordering is by weight x shortfall, so the metric listed first is genuinely
 * the biggest available lever for THIS expert. Only the resulting order is
 * returned. The gap value it was sorted on stays here.
 */
function buildSignals(t) {
  if (!t) return { signals: [], reliable: false, topLever: null };

  const pool = numOrNull(t.language_pool_size);
  const reliable = pool != null && pool >= MIN_POOL_FOR_SIGNALS;

  const scored = WEIGHTS
    .map((w) => {
      const prank = numOrNull(t[w.prankField]);
      if (prank === null) return null;
      return {
        metric: w.metric,
        prank,
        gap: w.weight * (100 - prank),   // private — sort key only
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.gap - a.gap);

  const needsWork = scored.filter((s) => s.prank < NEEDS_WORK_BELOW).slice(0, MAX_NEEDS_WORK);
  const needsWorkSet = new Set(needsWork.map((s) => s.metric));

  const signals = scored.map((s) => ({
    metric: s.metric,
    title: SIGNAL_TITLES[s.metric] || s.metric,
    signal: needsWorkSet.has(s.metric) ? 'needs_work' : 'on_track',
    label: needsWorkSet.has(s.metric) ? 'Needs work' : null,
    advice: needsWorkSet.has(s.metric) ? (SIGNAL_ADVICE[s.metric] || null) : null,
    // No prank, no gap, no weight. See the disclosure boundary note up top.
  }));

  return {
    signals,
    reliable,
    topLever: needsWork.length ? needsWork[0].metric : null,
  };
}

/**
 * The one thing we can state as an exact target.
 *
 * The gate is a fixed count, not a ranking, so telling an expert precisely how
 * many calls they still need cannot become a broken promise the way a
 * percentile cutoff would. Everything else stays directional.
 */
function volumeGate(t) {
  if (!t) return null;
  const connected = numOrNull(t.connected_calls_7d);
  if (connected === null) return null;

  const required = 48;
  const remaining = numOrNull(t.calls_to_volume_gate) ?? Math.max(0, required - connected);
  const met = t.meets_volume_gate === true
           || t.meets_volume_gate === 'true'
           || t.meets_volume_gate === 'TRUE'
           || connected >= required;

  return { required, connected, remaining, met };
}

/**
 * Nudge copy. Names the biggest lever when there is one, so the line is
 * actionable rather than motivational filler.
 */
function nudgeFor(tier, topLever, gate) {
  // The gate deliberately does NOT short-circuit this. It used to replace the
  // lever with "connect N more calls to qualify for a higher tier", which told
  // a buddy with poor pickup and short calls that volume alone would promote
  // them. It won't. The gate has its own block on screen saying it's a floor;
  // the nudge stays on the thing that actually moves the ranking.
  if (topLever) {
    const title = SIGNAL_TITLES[topLever] || topLever;
    return `Your biggest lever right now is ${title}.`;
  }
  const next = NEXT_TIER[tier];
  if (!next) return 'You\u2019re at the top tier. Keep it steady.';
  return `Keep your numbers steady to reach ${next}.`;
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

/** Signed change between two rates. Null unless both sides exist. */
function delta(cur, prev) {
  const a = numOrNull(cur), b = numOrNull(prev);
  if (a === null || b === null) return null;
  return Math.round((a - b) * 10) / 10;
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

/**
 * Build the full payload the webview renders.
 *
 * `identity` is { type: 'mobile' | 'user_id', value }. Both entry paths land
 * on the same metrics row, so everything below this point is identical
 * regardless of how the expert got in.
 */
export async function buildDashboard(identity) {
  const m = identity?.type === 'user_id'
    ? await lookupExpertByUserId(identity.value)
    : await lookupExpert(identity?.value);

  if (!m) return null;

  const t = await resolveTier(m);

  // Not in the VP output => excluded from the eligibility pool or below the
  // cohort floor. Show Base rather than an error, and never say why. The
  // exclusion reason is Class 3: it is covered by one line in the T&Cs and
  // must not be inferable from anything in this payload — which is why an
  // excluded expert renders identically to an unranked one.
  const tier = t?.payout_bucket || 'Base';

  const { signals, reliable: signalsReliable, topLever } = buildSignals(t);
  const gate = volumeGate(t);

  // Percentile is used to place the marker and is NOT returned. topPercent
  // stays null in the payload so the "Top N%" badge never renders — a public
  // percentile plus a public tier lets two experts triangulate the cutoff
  // between them.
  const standing = numOrNull(t?.top_percent);
  const geom = ladderGeometry(standing);
  const segments = geom.segments;
  const markerPos = standing != null ? geom.markerPos : segmentCentre(segments, tier);

  // Progress is renormalised inside the band by SQL, so 0 and 100 mean "just
  // entered this tier" and "at the edge of the next" — no cutoff recoverable.
  const tierProgress = numOrNull(t?.tier_progress_pct);

  const daily = normalizeDaily(m.daily);
  const labels = daily.map((d) => shortDate(d.day));

  const hasActivity = m.has_activity_7d === true || m.has_activity_7d === 'true' || Number(m.active_days_7d) > 0;

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
      nextTier: NEXT_TIER[tier] || null,
      // Base is the bottom of a relative ranking, and for most buddies it just
      // means "not in the top slice" — showing it as a badge reads as a
      // demotion notice. Below Silver we hide the tier block entirely and
      // reframe the signals as things to work on.
      showTier: tier !== 'Base',
      ranked: Boolean(t),
      topPercent: null,        // deliberately withheld — see above
      tierProgress,
      segments,
      markerPos,
      volumeGate: gate,
      nudge: nudgeFor(tier, topLever, gate),
      signals,
      signalsReliable,
    },
    retention: {
      pct: numOrNull(m.retention_3d_pct),
      cohort: numOrNull(m.retention_cohort_size) ?? 0,
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
      // Week-over-week. NULL when the prior week was too thin to compare.
      pickupDelta: delta(m.pickup_pct, m.pickup_pct_prev),
      rejectedDelta: delta(m.rejected_pct, m.rejected_pct_prev),
      dnpDelta: delta(m.dnp_pct, m.dnp_pct_prev),
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
          delta: delta(m.short_call_pct, m.short_call_pct_prev),
          values: daily.map((d) => d.shortCallPct),
        },
      ],
    },
  };
}
