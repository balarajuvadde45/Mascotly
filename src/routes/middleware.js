// Shared route middleware: auth, rate limiting, SSE helpers, typed errors.
import { timingSafeEqualStr } from '../util.js';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function extractKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-mascot-key'] || '').trim();
}

export function makeAuth(store) {
  function isAdmin(req) {
    const expected = config.adminKey || store.ensureAdminKey().key;
    const got = extractKey(req);
    return !!got && timingSafeEqualStr(got, expected);
  }

  function requireAdmin(req, res, next) {
    if (!isAdmin(req)) return next(new HttpError(401, 'Admin key required (X-Mascot-Key header or Authorization: Bearer)', 'unauthorized'));
    next();
  }

  /** Admin key OR the app's secret key. Attaches req.app on success. */
  function requireAppAccess(req, res, next) {
    const app = store.getApp(req.params.appId);
    if (!app) return next(new HttpError(404, 'App not found', 'not_found'));
    const got = extractKey(req);
    if (got && timingSafeEqualStr(got, app.secretKey)) {
      req.app = app;
      return next();
    }
    if (isAdmin(req)) {
      req.app = app;
      return next();
    }
    next(new HttpError(401, 'App secret key or admin key required', 'unauthorized'));
  }

  return { isAdmin, requireAdmin, requireAppAccess };
}

/** Validate the (appId, publicKey) pair for public widget endpoints. */
export function loadPublicApp(store) {
  return (req, res, next) => {
    const app = store.getApp(req.params.appId);
    if (!app) return next(new HttpError(404, 'App not found', 'not_found'));
    if (!timingSafeEqualStr(String(req.params.publicKey || ''), app.publicKey)) {
      return next(new HttpError(401, 'Invalid public key for this app', 'unauthorized'));
    }
    // Origin allowlist (widget embedding control).
    const allowed = app.settings?.allowedOrigins || [];
    if (allowed.length) {
      const origin = String(req.headers.origin || '');
      const referer = String(req.headers.referer || '');
      const candidates = [origin, referer ? new URL(referer).origin : ''].filter(Boolean);
      const ok = candidates.some((c) => allowed.some((pattern) => {
        if (pattern === '*') return true;
        if (pattern.startsWith('*.')) return c.endsWith(pattern.slice(1)) || c === `https://${pattern.slice(2)}`;
        return c === pattern;
      }));
      if (!ok) return next(new HttpError(403, `Origin ${origin || '(unknown)'} is not in this app's allowlist`, 'origin_blocked'));
    }
    req.app = app;
    next();
  };
}

/** In-memory sliding-window rate limiter. `max` may be a number or fn(req). */
export function slidingWindow({ windowMs = 60_000, max = 20, keyFn } = {}) {
  const maxOf = typeof max === 'function' ? max : () => max;
  const hits = new Map(); // key -> timestamps[]
  let lastSweep = Date.now();
  return (req, res, next) => {
    const now = Date.now();
    // Periodic sweep to keep memory bounded.
    if (now - lastSweep > 5 * windowMs) {
      lastSweep = now;
      for (const [k, arr] of hits) {
        const fresh = arr.filter((t) => now - t < windowMs);
        if (fresh.length) hits.set(k, fresh);
        else hits.delete(k);
      }
    }
    const maxN = Math.max(1, Math.min(1000, Number(maxOf(req)) || 20));
    const key = keyFn(req);
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= maxN) {
      const retryAfter = Math.ceil((arr[0] + windowMs - now) / 1000);
      res.set('retry-after', String(Math.max(1, retryAfter)));
      return next(new HttpError(429, `Rate limit reached (${maxN} msgs/min). Try again in ${retryAfter}s.`, 'rate_limited'));
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

export function sseInit(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
}

export function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** CORS: public read for API, permissive for widget endpoints. */
export function corsLite(req, res, next) {
  res.set('access-control-allow-origin', '*');
  res.set('access-control-allow-headers', 'content-type, authorization, x-mascot-key');
  res.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.set('access-control-expose-headers', 'retry-after');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function errorHandler(err, req, res, _next) {
  const status = err.status || (err.code === 'knowledge_limit' || err.code === 'no_knowledge' ? 400 : 500);
  if (status >= 500) {
    console.error(`[api] ${req.method} ${req.originalUrl} → ${status}:`, err.message, '\n', err.stack?.split('\n').slice(1, 4).join('\n'));
  }
  res.status(status).json({
    error: err.code || 'error',
    message: err.message || 'Internal error',
  });
}
