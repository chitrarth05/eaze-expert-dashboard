/**
 * dashboard-service.js — joins the metrics query (Redash) and the Variable
 * Pricing sheet into the payload the webview renders.
 *
 * Nothing is scored here. The paid tier comes from the pricing sheet. The
 * week's numbers and the pass/fail of every tier target come from the
 * metrics query, which carries the same `tier_gates` block as the pricing
 * query. This layer picks what to show and writes the copy.
 *
 * ── DISCLOSURE BOUNDARY (read before changing anything below) ──────────────
 *
 *   1. PUBLISHABLE — the tier targets. They are fixed numbers, identical in
 *      the pricing query and the metrics query (the `tier_gates` block), so
 *      stating them exactly is a promise the system keeps.
 *
 *   2. NEVER LEAVES THE SERVER — quality_standing, metric_tier, the excluded
 *      list, multipliers. None of these are copied into the payload.
 *
 *      The only visible trace of a review outcome is `notConfirmed`: one
 *      neutral line shown when last week's numbers earned a higher tier than
 *      the one confirmed. It never says why, and the same rule line is shown
 *      to every expert, so it reads as a published rule being applied rather
 *      than as an accusation.
 *
 * ── WEEK ─────────────────────────────────────────────────────────────────
 * The tier week is Monday–Sunday IST. Tuesday to Sunday the metrics query
 * returns this week so far; on Monday it returns last week, finished, which
 * is exactly what the 05:00 pricing run used.
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

/** Shown to every expert, every time. The rule, never a personal verdict. */
const RULE_LINE =
  'Tiers are set every Monday from the past week\u2019s numbers and confirmed in a ' +
  'weekly review, which also checks that calls follow eaze guidelines.';

const NOT_CONFIRMED_LINE =
  'Your numbers last week met the targets, but this week\u2019s tier wasn\u2019t ' +
  'confirmed in the weekly review.';

/** Plain names for each target, as an expert would say them. */
const CHECK_LABELS = {
  calls:    'Calls taken',
  pickup:   'Pickup rate',
  acd:      'Average call length',
  short:    'Calls under 10 seconds',
  talktime: 'Time on calls',
};

/** One concrete thing to do about each target. */
const CHECK_ACTIONS = {
  calls:    'Stay online through busy hours so more calls reach you.',
  pickup:   'Answer the calls that come to you instead of letting them ring out or declining.',
  acd:      'Give each call a little more time so the conversation actually lands.',
  short:    'Be on a strong network and ready to talk the moment a call connects.',
  talktime: 'Spend more total time on calls across the week.',
};

// ── Small helpers ────────────────────────────────────────────────────────────

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function truthy(v) {
  return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1';
}

/** Round toward "not passed", matching the SQL display rule. */
const floor1 = (v) => Math.floor(v * 10 + 1e-9) / 10;
const ceil1  = (v) => Math.ceil(v * 10 - 1e-9) / 10;

/** 82 → "82", 4.5 → "4.5". */
function trim(n) {
  return Number(n).toFixed(1).replace(/\.0$/, '');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return `${d.getUTCDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]}`;
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

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
 * Pricing-sheet row for a metrics row. mobile_10 first, ids as fallback, so
 * tier resolution never depends on how the expert signed in.
 */
async function resolveTier(m) {
  const byMobile = await getTierByMobile(normalizeMobile(m.mobile_10 || m.mobile_no));
  if (byMobile) return byMobile;
  return (await getTierById(m.expert_user_id))
      || (await getTierById(m.expert_profile_id))
      || undefined;
}

// ── Tier targets ─────────────────────────────────────────────────────────────

/**
 * Tier names in rank order, from the gates the query returned. Base is rank 0
 * and has no gates, so it's added here.
 */
function ladderFrom(targets) {
  const byRank = new Map([[0, 'Base']]);
  for (const r of targets) {
    const rank = numOrNull(r.tier_rank);
    if (rank !== null && !byRank.has(rank)) byRank.set(rank, r.tier_name);
  }
  return [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([rank, name]) => ({ rank, name }));
}

/** Which gates on a route are switched on. Neutral values mean "not used". */
function activeGates(r) {
  const out = [];
  if (numOrNull(r.min_connected_calls) > 0) out.push('calls');
  if (numOrNull(r.min_pur_pct) > 0)         out.push('pickup');
  if (numOrNull(r.min_acd_mins) > 0)        out.push('acd');
  if (numOrNull(r.max_short_call_pct) < 100) out.push('short');
  if (numOrNull(r.min_talktime_mins) > 0)   out.push('talktime');
  return out;
}

const PASS_FIELD = {
  calls: 'pass_calls', pickup: 'pass_pur', acd: 'pass_acd',
  short: 'pass_short', talktime: 'pass_talktime',
};

function routeProgress(r) {
  const gates = activeGates(r);
  if (!gates.length) return 1;
  return gates.filter((g) => truthy(r[PASS_FIELD[g]])).length / gates.length;
}

/**
 * The route to show for a tier: a passing one if any, otherwise the one the
 * expert is closest to. Ties go to the quality route.
 */
function bestRoute(routes) {
  return [...routes].sort((a, b) =>
    (truthy(b.passes) - truthy(a.passes))
    || (routeProgress(b) - routeProgress(a))
    || ((b.route === 'quality') - (a.route === 'quality'))
  )[0] || null;
}

/**
 * One row per target on a route: what it is, where the expert stands, and
 * how far is left. Pass/fail always comes from the query, which checked the
 * unrounded value; the numbers here are only for display and are rounded
 * toward "not passed" so the two can never visibly disagree.
 */
function buildChecks(r, m, { withValues, daysLeft }) {
  const calls = numOrNull(m.connected_calls) ?? 0;
  const pur   = numOrNull(m.gate_pur_pct);
  const acd   = numOrNull(m.gate_acd_mins);
  const short = numOrNull(m.gate_short_call_pct);
  const talk  = numOrNull(m.gate_talktime_mins) ?? 0;

  const pace = (text) => (daysLeft > 0 ? `${text} \u00b7 ${plural(daysLeft, 'day')} left` : text);

  return activeGates(r).map((key) => {
    const met = withValues ? truthy(r[PASS_FIELD[key]]) : null;
    const row = { key, label: CHECK_LABELS[key], met, value: null, target: '', gap: null, action: null };

    if (key === 'calls') {
      const t = numOrNull(r.min_connected_calls);
      row.target = `${t} or more`;
      if (withValues) {
        row.value = `${calls}`;
        if (!met) row.gap = pace(`${t - calls} more to go`);
      }
    } else if (key === 'pickup') {
      const t = numOrNull(r.min_pur_pct);
      row.target = `${trim(t)}% or more`;
      if (withValues) {
        row.value = pur === null ? '\u2013' : `${trim(floor1(pur))}%`;
        if (!met) row.gap = `${trim(Math.max(0.1, ceil1(t - (pur ?? 0))))} points to go`;
      }
    } else if (key === 'acd') {
      const t = numOrNull(r.min_acd_mins);
      row.target = `${trim(t)} min or more`;
      if (withValues) {
        row.value = acd === null ? '\u2013' : `${trim(floor1(acd))} min`;
        if (!met) row.gap = `${trim(Math.max(0.1, ceil1(t - (acd ?? 0))))} min to go`;
      }
    } else if (key === 'short') {
      const t = numOrNull(r.max_short_call_pct);
      row.target = `${trim(t)}% or less`;
      if (withValues) {
        row.value = short === null ? '\u2013' : `${trim(ceil1(short))}%`;
        if (!met) row.gap = `${trim(Math.max(0.1, ceil1((short ?? 100) - t)))} points too high`;
      }
    } else if (key === 'talktime') {
      const t = numOrNull(r.min_talktime_mins);
      row.target = `${Math.round(t)} min or more`;
      if (withValues) {
        row.value = `${Math.floor(talk)} min`;
        if (!met) row.gap = pace(`${Math.max(1, Math.ceil(t - talk))} min to go`);
      }
    }

    if (withValues && !met) row.action = CHECK_ACTIONS[key];
    return row;
  });
}

/** One-line summary of a route's targets, for "another way to get there". */
function routeSummary(r) {
  const parts = activeGates(r)
    .filter((k) => k !== 'calls')   // every route has the same call floor
    .map((k) => {
      if (k === 'pickup')   return `pickup ${trim(r.min_pur_pct)}%+`;
      if (k === 'acd')      return `calls averaging ${trim(r.min_acd_mins)} min+`;
      if (k === 'short')    return `${trim(r.max_short_call_pct)}% or fewer calls under 10s`;
      if (k === 'talktime') return `${Math.round(r.min_talktime_mins)}+ min on calls`;
      return null;
    })
    .filter(Boolean);
  if (!parts.length) return null;
  const last = parts.pop();
  return parts.length ? `${parts.join(', ')} and ${last}` : last;
}

/**
 * A checklist for one tier: the closest route's targets, plus a line naming
 * the other route when there is one and it isn't the one being shown.
 */
function checklistFor(rank, targets, m, ladder, opts) {
  const routes = targets.filter((r) => numOrNull(r.tier_rank) === rank);
  if (!routes.length) return null;
  const best = bestRoute(routes);
  const other = routes.find((r) => r.route !== best.route);
  const name = ladder.find((t) => t.rank === rank)?.name || best.tier_name;

  return {
    tier: name,
    title: opts.title(name),
    met: opts.withValues ? truthy(best.passes) : null,
    checks: buildChecks(best, m, opts),
    alt: other ? routeSummary(other) : null,
  };
}

/**
 * The tier section.
 *
 * Wording rule: never "you will be X". Every forward-looking line says "on
 * track", because the review at reset can still decide otherwise.
 */
function buildEarningTier(m, t) {
  const targets = parseArray(m.tier_targets);
  const ladder  = ladderFrom(targets);
  const rankOf  = (name) => ladder.find((x) => x.name === name)?.rank ?? 0;
  const topRank = ladder[ladder.length - 1]?.rank ?? 0;

  const current     = t?.payout_bucket || 'Base';
  const currentRank = rankOf(current);
  const weekRank    = numOrNull(m.week_tier_rank) ?? 0;
  const weekName    = ladder.find((x) => x.rank === weekRank)?.name || 'Base';

  const isFinal  = truthy(m.is_week_final);
  const daysLeft = numOrNull(m.days_left_in_week) ?? 0;
  const elapsed  = numOrNull(m.window_days) ?? 0;

  // Monday before the 05:00 run has written the new week to the sheet.
  const sheetWeekEnd = String(t?.range_end_ist || '').slice(0, 10);
  const weekEnd      = String(m.week_end_ist || '').slice(0, 10);
  const tierPending  = isFinal && Boolean(sheetWeekEnd) && sheetWeekEnd < weekEnd;

  // Numbers earned a higher tier than the one confirmed. See the boundary
  // note up top: this flag is the ONLY thing derived from the review columns.
  const notConfirmed = !tierPending
    && t?.quality_standing === 'Under review'
    && rankOf(t?.metric_tier) > currentRank;

  let status, headline, sub, checklist = null;

  if (isFinal) {
    // Monday: last week is closed. Nothing to track yet; show the targets.
    if (tierPending) {
      status = 'pending';
      headline = 'Last week is done';
      sub = 'Your tier for this week updates by 5am today.';
    } else {
      status = 'new_week';
      headline = current;
      sub = 'Your tier for this week. This week\u2019s numbers start showing tomorrow.';
      const aim = Math.min(currentRank + 1, topRank);
      if (aim > 0) {
        checklist = checklistFor(aim, targets, m, ladder, {
          withValues: false, daysLeft: 0,
          title: (n) => (aim === currentRank ? `Keep ${n} next week` : `Reach ${n} next week`),
        });
      }
    }
  } else if (currentRank > 0 && weekRank < currentRank) {
    status = 'at_risk';
    headline = `Keep ${current}`;
    sub = `You\u2019re below your ${current} targets this week. Get these back by Sunday to keep it.`;
    checklist = checklistFor(currentRank, targets, m, ladder, {
      withValues: true, daysLeft, title: (n) => `To keep ${n}`,
    });
  } else if (weekRank > currentRank) {
    status = 'on_track_up';
    headline = `On track for ${weekName}`;
    sub = weekRank === topRank
      ? 'That\u2019s the top tier. Keep this up through Sunday.'
      : 'Keep this up through Sunday to move up next week.';
    if (weekRank < topRank) {
      checklist = checklistFor(weekRank + 1, targets, m, ladder, {
        withValues: true, daysLeft, title: (n) => `To reach ${n}`,
      });
    }
  } else if (currentRank === topRank && currentRank > 0) {
    status = 'holding_top';
    headline = `Holding ${current}`;
    sub = 'You\u2019re meeting the top tier\u2019s targets. Keep it steady through Sunday.';
  } else if (currentRank > 0) {
    status = 'holding';
    headline = `Holding ${current}`;
    sub = `You\u2019re meeting your ${current} targets this week.`;
    checklist = checklistFor(currentRank + 1, targets, m, ladder, {
      withValues: true, daysLeft, title: (n) => `To reach ${n}`,
    });
  } else {
    status = 'climbing';
    const next = ladder.find((x) => x.rank === 1)?.name || 'Silver';
    headline = `Reach ${next}`;
    sub = 'Hit all of these by Sunday to move up next week.';
    checklist = checklistFor(1, targets, m, ladder, {
      withValues: true, daysLeft, title: (n) => `To reach ${n}`,
    });
  }

  return {
    tier: current,
    status,
    headline,
    sub,
    early: !isFinal && elapsed > 0 && elapsed <= 2,
    ladder: ladder.map((x) => ({
      name: x.name,
      current: x.rank === currentRank,
      // Only marks a move UP. A drop is handled by the "Keep X" headline.
      onTrack: !isFinal && x.rank === weekRank && weekRank > currentRank,
    })),
    checklist,
    notConfirmed,
    notConfirmedText: notConfirmed ? NOT_CONFIRMED_LINE : null,
    ruleLine: RULE_LINE,
    daysLeft,
    isFinal,
  };
}

// ── Reset clock ──────────────────────────────────────────────────────────────

const IST_OFFSET = '+05:30';
const WEEK_MS    = 7 * 24 * 60 * 60 * 1000;

/**
 * Countdown to the Monday 05:00 IST reset, derived at REQUEST time so it
 * keeps moving between daily Redash refreshes.
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

// ── Day-wise series ──────────────────────────────────────────────────────────

function normalizeDaily(daily) {
  return parseArray(daily).map((d) => ({
    day: d.day_ist,
    wasActive: truthy(d.was_active),
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

// ── Payload ──────────────────────────────────────────────────────────────────

/**
 * Build the full payload the webview renders.
 *
 * `identity` is { type: 'mobile' | 'user_id', value }. Both entry paths land
 * on the same metrics row.
 */
export async function buildDashboard(identity) {
  const m = identity?.type === 'user_id'
    ? await lookupExpertByUserId(identity.value)
    : await lookupExpert(identity?.value);

  if (!m) return null;

  const t = await resolveTier(m);
  const daily = normalizeDaily(m.daily);
  const labels = daily.map((d) => shortDate(d.day));
  const hasActivity = truthy(m.has_activity_week) || Number(m.active_days_week) > 0;
  const isFinal = truthy(m.is_week_final);

  return {
    expert: {
      id: m.expert_profile_id,
      name: m.expert_name,
      locale: m.locale || 'en',
      onboardedDate: m.onboarded_date_ist,
    },
    window: {
      // Mon–Sun tier week. Tue–Sun: this week so far. Monday: last week, done.
      start: m.window_start_ist,
      end: m.window_end_ist,
      weekEnd: m.week_end_ist,
      days: numOrNull(m.window_days),
      isFinal,
      startLabel: shortDate(m.window_start_ist),
      endLabel: shortDate(m.window_end_ist),
      weekEndLabel: shortDate(m.week_end_ist),
      dataThroughLabel: shortDate(m.data_through_ist || m.window_end_ist),
      labels,
    },
    reset: resetClock(m.next_reset_ist),
    earningTier: buildEarningTier(m, t),
    retention: {
      pct: numOrNull(m.retention_3d_pct),
      cohort: numOrNull(m.retention_cohort_size) ?? 0,
    },
    activity: {
      hasActivity,
      activeDays: numOrNull(m.active_days_week) ?? 0,
    },
    callResponse: {
      requests: numOrNull(m.response_requests) ?? 0,
      pickupPct: numOrNull(m.pickup_pct),
      rejectedPct: numOrNull(m.rejected_pct),
      dnpPct: numOrNull(m.dnp_pct),
      // Against last full week. NULL when last week was too thin to compare.
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
