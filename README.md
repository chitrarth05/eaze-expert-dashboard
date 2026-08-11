# eaze — Expert Dashboard

A mobile webview where eaze experts see their earning tier, call response,
active hours and call quality. Experts sign in with their registered mobile
number; everything they see comes from two Redash queries.

## How it fits together

```
Variable Pricing query  ──┐
(already on a schedule)   │
                          ├─ joined on mobile_10 ─→ Express ─→ webview
Expert metrics query    ──┘        (in-memory cache)
```

* **Tiers** come from the Variable Pricing ranking query. Nothing is
  re-scored here — if the dashboard recomputed the ranking on its own window
  an expert could see a different tier than the one they're paid on.
* **Everything else** — call response, hours, call quality, the day-wise
  series, the within-language signals and the reset clock — comes from the
  expert metrics query.
* Both are joined on `mobile_10` (last 10 digits). Raw `mobile_no` formatting
  is inconsistent (+91, spaces, leading zero), so joining on it directly drops
  experts silently.

## Setup

```bash
cp .env.example .env      # fill in Redash URL, API key, both query ids
npm install
npm run redash:test       # verifies both queries and the join before you deploy
npm start                 # http://localhost:3000
```

`npm run redash:test` is worth running first. It checks that both queries
return, that the expected columns exist, that `daily` has 7 elements, and —
most usefully — what share of ranked experts actually match a metrics row. If
that match rate is low, the two queries are formatting mobile numbers
differently.

## Docker

```bash
docker compose up --build      # reads .env
# or
docker build -t eaze-expert-dashboard .
docker run --env-file .env -p 3000:3000 eaze-expert-dashboard
```

Pushes to `main` publish `ghcr.io/<owner>/eaze-expert-dashboard:latest` via
`.github/workflows/docker-publish.yml`.

## Required Redash columns

**Metrics query** (`sql/02_dashboard_expert_metrics.sql`)
`expert_profile_id`, `expert_name`, `mobile_10`, `locale`, `has_activity_7d`,
`active_days_7d`, `response_requests`, `pickup_pct`, `rejected_pct`, `dnp_pct`,
`active_hours`, `audio_active_hours`, `other_active_hours`, `finished_calls`,
`avg_call_duration_mins`, `audio_contribution_pct`, `short_call_pct`,
`next_reset_ist`, `hours_to_reset`, `days_to_reset`, `signals`,
`signals_reliable`, `daily`

**Tiers query** (`sql/00_variable_pricing_ranking.sql`)
`mobile_10`, `payout_bucket`, `final_prank`

`mobile_10` had to be added to the VP query's final SELECT — it wasn't there
originally.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | container healthcheck |
| POST | `/api/auth/login` | `{ mobileNumber }` → signed session cookie |
| POST | `/api/auth/logout` | clears the cookie |
| GET | `/api/me/dashboard` | full payload; 401 without a session |
| GET | `/api/cache` | cache ages, for debugging |
| POST | `/api/cache/clear` | force a re-pull; needs `x-admin-token` if `ADMIN_TOKEN` set |

## Design decisions worth knowing

**No numeric targets are shown.** Tier placement is relative to other experts
in the same language, and also depends on inputs we can't expose (violations,
eligibility). Publishing "hit 90% pickup for Diamond" would create a promise
the system can't keep — an expert could meet every visible number, be excluded
for a violation, and reasonably feel cheated. So the dashboard shows direction
only, with a line saying other factors apply.

**Only "Needs work" carries a label.** Strong and steady render as a quiet
check. Praise labels add noise and slow down scanning.

**Inactive days are `null`, not `0`.** A day off and a day with zero pickups
are different things. Nulls render as a dashed empty slot so time off never
reads as poor performance. An expert with no activity at all in the window
gets a dedicated empty state rather than a screen of zeroes.

**Signals are suppressed in thin language pools.** A percentile across three
experts is noise, so `signals_reliable` is false below 20 rankable experts in
a language and the UI hides the block.

**Identity comes from a signed cookie.** The client never asserts who it is —
the mobile is read from an HMAC-signed session, so a tampered value fails the
signature rather than exposing another expert's numbers.

## Caching

Redash results are held in memory: metrics 15 min, tiers 1 hour (both
configurable). Concurrent misses share a single fetch rather than stampeding.

This is per-process. Running multiple replicas multiplies the polling against
Redash — swap the `Map` in `src/redash.js` for Redis before scaling out.

## Known gaps

* **Retention isn't in the signals.** It's 30% of the tier score — the single
  largest factor — but computing it needs the cohort logic from the VP query.
  An expert can currently see every signal green and still be missing the
  biggest lever.
* **Signal ranks don't exactly match VP ranks.** Signals rank on the rolling
  7-day window across all active experts; VP ranks on its own window across
  experts who clear the cohort gate. Intentional — signals answer "how am I
  doing now" — but it means green signals don't guarantee tier movement.
* **Translations aren't wired.** `locale` flows through the payload but the UI
  strings are English. The seam is there for when translations are verified.
