import dotenv from 'dotenv';
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildDashboard, lookupExpert, lookupExpertByUserId } from './dashboard-service.js';
import { cacheStatus, clearCache, normalizeMobile, normalizeId } from './redash.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const publicDir = __dirname;

const app  = express();
const port = Number(process.env.PORT || 3000);

const SESSION_SECRET  = process.env.SESSION_SECRET || 'dev-only-change-me';
const SESSION_COOKIE  = 'eaze_expert_session';
const SESSION_MAX_AGE = Number(process.env.SESSION_MAX_AGE_SECONDS || 43200); // 12h
const COOKIE_SECURE   = String(process.env.COOKIE_SECURE || 'false') === 'true';

/**
 * AUTH_MODE — the backend toggle for how experts get in.
 *   'mobile'  (default) mobile-number login only. Safe standard.
 *   'user_id'           URL token only: ?uid=<base64 of expert_user_id>.
 *   'both'               accept a URL token when present, otherwise show the
 *                        mobile login. Use this while the app rollout is
 *                        partial so older app versions still work.
 *
 * NOTE: a base64 user id is ENCODING, not authentication — anyone can encode
 * someone else's id and read their dashboard. Acceptable only because the URL
 * is produced inside the app. Do not put this mode on a link that leaves the
 * app, and move to a signed token before this holds anything more sensitive.
 */
const AUTH_MODE = (() => {
  const v = String(process.env.AUTH_MODE || 'mobile').toLowerCase().trim();
  return ['mobile', 'user_id', 'both'].includes(v) ? v : 'mobile';
})();

const mobileAllowed = () => AUTH_MODE === 'mobile' || AUTH_MODE === 'both';
const userIdAllowed = () => AUTH_MODE === 'user_id' || AUTH_MODE === 'both';

/** Accept base64, base64url, or a bare numeric id. Returns '' if unusable. */
function decodeUidParam(raw) {
  const input = String(raw || '').trim();
  if (!input) return '';
  if (/^\d+$/.test(input)) return input;            // already plain
  try {
    const decoded = Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8').trim();
    return normalizeId(decoded);
  } catch {
    return '';
  }
}

app.use(express.json());

// NOTE: deliberately NOT express.static(publicDir). publicDir is the app root,
// so a static mount would serve server.js, redash.js, dashboard-service.js,
// package.json and google-credentials.json over the public URL. (Dotfiles like
// .env are 404'd by default, but nothing else is.) The webview is a single
// self-contained file — every asset is inlined — so index.html is the only
// thing that ever needs serving.
app.get('/', (_req, res) => {
  // no-store: the whole app lives in this one file, so a webview holding a
  // stale copy is a stale deploy. It's ~60KB; revalidating every open is cheap.
  res.set('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── Sessions ──────────────────────────────────────────────────────────────────
// Signed cookie holding the expert's mobile. The client never gets to assert an
// identity — every dashboard read resolves the mobile from this cookie, so a
// tampered value fails the signature check rather than exposing another
// expert's numbers.

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

// Payload is `type:value:issuedAt`. Type is part of the signed material so a
// mobile session can never be replayed as a user_id session or vice versa.
function issueSession(identity) {
  const payload = `${identity.type}:${identity.value}:${Date.now()}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

function readSession(token) {
  if (!token) return null;
  const [encoded, sig] = String(token).split('.');
  if (!encoded || !sig) return null;
  let payload;
  try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return null; }

  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [type, value, issuedAt] = payload.split(':');
  if (!type || !value || !issuedAt) return null;
  if (!['mobile', 'user_id'].includes(type)) return null;
  if (Date.now() - Number(issuedAt) > SESSION_MAX_AGE * 1000) return null;

  // A session issued under a mode that is no longer enabled must not survive a
  // toggle flip, or disabling a path wouldn't actually disable it.
  if (type === 'mobile'  && !mobileAllowed()) return null;
  if (type === 'user_id' && !userIdAllowed()) return null;

  return { type, value };
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, identity) {
  res.cookie(SESSION_COOKIE, issueSession(identity), {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE * 1000,
  });
}

function requireExpert(req, res, next) {
  const identity = readSession(parseCookies(req)[SESSION_COOKIE]);
  if (!identity) return res.status(401).json({ error: 'Not authenticated' });
  // Sliding expiry. Without this the session dies a fixed SESSION_MAX_AGE after
  // the ORIGINAL login regardless of use, so a regular user gets kicked back to
  // the number-entry screen mid-week. Re-issuing on each authenticated request
  // means only genuine inactivity logs them out.
  setSessionCookie(res, identity);
  req.identity = identity;
  next();
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'eaze-expert-dashboard' });
});

// The webview asks this first so it renders the right entry screen.
app.get('/api/config', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ authMode: AUTH_MODE, mobileLogin: mobileAllowed(), urlLogin: userIdAllowed() });
});

app.get('/api/cache', (_req, res) => {
  res.json(cacheStatus());
});

// Admin-ish: force a re-pull from Redash on the next request.
app.post('/api/cache/clear', (req, res) => {
  const token = process.env.ADMIN_TOKEN;
  if (token && req.headers['x-admin-token'] !== token) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  clearCache();
  res.json({ ok: true });
});

/**
 * Login by registered mobile.
 * The expert must exist in the metrics query output; if they don't, they
 * aren't an active expert and we say so plainly without leaking whether the
 * number exists elsewhere on the platform.
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    if (!mobileAllowed()) {
      return res.status(403).json({ error: 'Mobile login is turned off.' });
    }
    const mobile = normalizeMobile(req.body?.mobileNumber);
    if (mobile.length !== 10) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    }

    const expert = await lookupExpert(mobile);
    if (!expert) {
      return res.status(404).json({ error: 'We couldn\u2019t find an active wellness buddy with that number.' });
    }

    setSessionCookie(res, { type: 'mobile', value: mobile });
    res.json({ ok: true, name: expert.expert_name, locale: expert.locale || 'en' });
  } catch (err) {
    console.error('[login]', err);
    res.status(502).json({ error: 'Could not reach the data source. Try again shortly.' });
  }
});

/**
 * URL entry: the app opens the banner at /?uid=<base64 expert_user_id>.
 * The webview posts that value here; on success it gets the same session
 * cookie the mobile path issues, and strips the param from the address bar.
 */
app.post('/api/auth/url', async (req, res) => {
  try {
    if (!userIdAllowed()) {
      return res.status(403).json({ error: 'Link sign-in is turned off.' });
    }

    const userId = decodeUidParam(req.body?.uid);
    if (!userId) return res.status(400).json({ error: 'That link looks incomplete.' });

    const expert = await lookupExpertByUserId(userId);
    if (!expert) {
      return res.status(404).json({ error: 'We couldn\u2019t find an active wellness buddy for this link.' });
    }

    setSessionCookie(res, { type: 'user_id', value: userId });
    res.json({ ok: true, name: expert.expert_name, locale: expert.locale || 'en' });
  } catch (err) {
    console.error('[url-auth]', err);
    res.status(502).json({ error: 'Could not reach the data source. Try again shortly.' });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.json({ ok: true });
});

app.get('/api/me/dashboard', requireExpert, async (req, res) => {
  try {
    const payload = await buildDashboard(req.identity);
    if (!payload) return res.status(404).json({ error: 'Wellness buddy not found' });
    res.json(payload);
  } catch (err) {
    console.error('[dashboard]', err);
    res.status(502).json({ error: 'Could not load your numbers right now.' });
  }
});

app.listen(port, () => {
  console.log(`eaze-expert-dashboard listening on :${port} (AUTH_MODE=${AUTH_MODE})`);
});
