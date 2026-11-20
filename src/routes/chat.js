// Public widget-facing API: widget config, chat (JSON + SSE stream), feedback.
// Auth = appId + publicKey in the path (embeddable, origin-allowlist aware).
import { Router } from 'express';
import { asyncHandler, HttpError, loadPublicApp, slidingWindow, sseInit, sseSend } from './middleware.js';
import { chatStream } from '../brain/agent.js';
import { fireHooks } from '../hooks.js';
import { newId, nowIso, truncate } from '../util.js';
import { config } from '../config.js';

/** Load or create a chat session, persist the exchange, enforce caps. */
function persistExchange(store, app, { sessionId, message, answer, citations, action, escalated, page, meta }) {
  const limit = config.limits.messagesPerSession;
  let session = null;
  if (sessionId) session = store.getSession(app.id, sessionId);
  if (!session) {
    session = {
      id: newId('ses'),
      appId: app.id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      messages: [],
      page: page || null,
      escalated: false,
      feedback: null,
    };
    app.stats.sessions = (app.stats.sessions || 0) + 1;
  }
  session.messages.push({ role: 'user', content: truncate(message, 4000), at: nowIso(), page: page?.url || undefined });
  session.messages.push({
    role: 'assistant',
    content: truncate(answer, 8000),
    citations: (citations || []).slice(0, 8).map((c) => ({ label: c.label, url: c.url, n: c.n })),
    action: action ? { name: action.name } : undefined,
    meta,
    at: nowIso(),
  });
  if (escalated) session.escalated = true;
  if (page) session.page = page;
  if (session.messages.length > limit * 2) {
    session.messages = session.messages.slice(-limit * 2);
  }

  // Enforce session cap per app: drop oldest when over budget.
  const sessions = store.listSessions(app.id);
  if (sessions.length >= config.limits.sessionsPerApp) {
    const excess = sessions.length - config.limits.sessionsPerApp + 1;
    for (const s of sessions.slice(-excess)) store.deleteSession(app.id, s.id);
  }

  store.saveSession(app.id, session);
  app.stats.messages = (app.stats.messages || 0) + 1;
  app.stats.lastChatAt = nowIso();
  store.saveApp(app);
  return session;
}

function widgetConfigView(app) {
  return {
    appId: app.id,
    appName: app.name,
    mascot: {
      name: app.mascot.name,
      emoji: app.mascot.emoji,
      color: app.mascot.color,
      greeting: app.mascot.greeting,
      tagline: app.mascot.tagline,
      position: app.mascot.position,
      welcome: app.mascot.welcome,
      avatarUrl: app.mascot.avatarUrl,
      suggestions: (app.mascot.suggestions || []).slice(0, 4),
      actions: (app.mascot.actions || []).map((a) => ({ name: a.name, description: a.description })),
    },
  };
}

function clientKey(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'local';
  return `${req.params.appId}:${ip}`;
}

export function buildChatRouter(store) {
  const chat = Router();
  // One shared limiter instance (per-app max read dynamically from req.app).
  const rateLimiter = slidingWindow({
    windowMs: 60_000,
    max: (req) => Math.max(1, Math.min(240, Number(req.app?.settings?.rateLimitPerMin) || 20)),
    keyFn: clientKey,
  });

  chat.get('/widget-config/:appId/:publicKey', loadPublicApp(store), (req, res) => {
    res.set('cache-control', 'public, max-age=30');
    res.json(widgetConfigView(req.app));
  });

  chat.post('/chat/:appId/:publicKey', loadPublicApp(store), rateLimiter, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    const message = String(b.message || '').trim().slice(0, 4000);
    if (!message) throw new HttpError(400, 'message is required', 'empty_message');

    let done = null;
    for await (const ev of chatStream(store, app, {
      message,
      history: Array.isArray(b.history) ? b.history.slice(-16) : [],
      page: b.page,
    })) {
      if (ev.type === 'done') done = ev;
      if (ev.type === 'error') throw new HttpError(400, ev.message || 'Chat failed', ev.error);
    }
    const session = persistExchange(store, app, {
      sessionId: b.sessionId ? String(b.sessionId).slice(0, 80) : null,
      message,
      answer: done.answer,
      citations: done.citations,
      action: done.action,
      escalated: done.escalated,
      page: b.page || null,
      meta: { provider: done.usage?.provider, model: done.usage?.model, latencyMs: done.usage?.latencyMs },
    });
    fireHooks(store, app, 'message', {
      message, answer: done.answer, sessionId: session.id,
      escalated: done.escalated, citations: (done.citations || []).length,
    });
    if (done.escalated) fireHooks(store, app, 'escalation', { message, sessionId: session.id });
    res.json({
      answer: done.answer,
      citations: done.citations,
      action: done.action,
      escalated: done.escalated,
      sessionId: session.id,
      usage: done.usage,
    });
  }));

  chat.post('/stream/:appId/:publicKey', loadPublicApp(store), rateLimiter, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    const message = String(b.message || '').trim().slice(0, 4000);
    if (!message) throw new HttpError(400, 'message is required', 'empty_message');

    sseInit(res);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 15000);
    req.on('close', () => clearInterval(heartbeat));

    try {
      sseSend(res, 'meta', { appId: app.id, mascotName: app.mascot.name });
      let done = null;
      for await (const ev of chatStream(store, app, {
        message,
        history: Array.isArray(b.history) ? b.history.slice(-16) : [],
        page: b.page,
      })) {
        if (ev.type === 'status') sseSend(res, 'status', { detail: ev.detail });
        else if (ev.type === 'delta') sseSend(res, 'delta', { text: ev.text });
        else if (ev.type === 'action') sseSend(res, 'action', ev.action);
        else if (ev.type === 'done') done = ev;
        else if (ev.type === 'error') {
          sseSend(res, 'error', { message: ev.message || 'Chat failed', code: ev.error });
        }
      }
      if (!done) throw new HttpError(500, 'No answer produced', 'no_answer');
      const session = persistExchange(store, app, {
        sessionId: b.sessionId ? String(b.sessionId).slice(0, 80) : null,
        message,
        answer: done.answer,
        citations: done.citations,
        action: done.action,
        escalated: done.escalated,
        page: b.page || null,
        meta: { provider: done.usage?.provider, model: done.usage?.model, latencyMs: done.usage?.latencyMs },
      });
      fireHooks(store, app, 'message', {
        message, answer: done.answer, sessionId: session.id,
        escalated: done.escalated, citations: (done.citations || []).length,
      });
      if (done.escalated) fireHooks(store, app, 'escalation', { message, sessionId: session.id });
      sseSend(res, 'done', {
        answer: done.answer,
        citations: done.citations,
        action: done.action,
        escalated: done.escalated,
        sessionId: session.id,
        usage: done.usage,
      });
    } catch (err) {
      sseSend(res, 'error', { message: err.message || 'Chat failed', code: err.code || 'error' });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }));

  chat.post('/feedback/:appId/:publicKey', loadPublicApp(store), asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.sessionId) throw new HttpError(400, 'sessionId is required');
    const session = store.getSession(req.app.id, String(b.sessionId).slice(0, 80));
    if (!session) throw new HttpError(404, 'Session not found', 'not_found');
    const rating = b.rating === 'up' || b.rating === 'down' ? b.rating : null;
    session.feedback = {
      rating,
      comment: truncate(String(b.comment || ''), 1000),
      at: nowIso(),
    };
    store.saveSession(req.app.id, session);
    fireHooks(store, req.app, 'feedback', { sessionId: session.id, rating, comment: session.feedback.comment });
    res.json({ ok: true });
  }));

  return chat;
}
