// Hook dispatcher: signed lifecycle webhooks (message / escalation / feedback).
// Fire-and-forget with a hard timeout; failures never affect the chat path.
import { createHmac } from 'node:crypto';

const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024;

export const HOOK_EVENTS = ['message', 'escalation', 'feedback'];

export function signPayload(secret, body) {
  return 'sha256=' + createHmac('sha256', String(secret || '')).update(body).digest('hex');
}

/** Validate a hook URL: http(s) only. Self-hosted admins may target localhost. */
export function isHookUrlAllowed(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Fire every enabled hook registered for an event. Never throws.
 * @param {object} store — used to persist delivery status
 * @param {object} app — app record
 * @param {string} event — 'message' | 'escalation' | 'feedback'
 * @param {object} data — event payload
 */
export function fireHooks(store, app, event, data) {
  const hooks = Array.isArray(app.hooks) ? app.hooks : [];
  for (const hook of hooks) {
    if (!hook || hook.enabled === false) continue;
    if (hook.event !== event) continue;
    if (!isHookUrlAllowed(hook.url)) continue;
    deliver(store, app, hook, event, data);
  }
}

function deliver(store, app, hook, event, data) {
  const payload = JSON.stringify({
    event,
    appId: app.id,
    appName: app.name,
    at: new Date().toISOString(),
    data: data || {},
  });
  const body = payload.length > MAX_BODY_BYTES
    ? payload.slice(0, MAX_BODY_BYTES)
    : payload;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(hook.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'MascotlyHooks/0.1',
      'x-mascot-event': event,
      'x-mascot-signature': signPayload(hook.secret, body),
    },
    body,
    signal: controller.signal,
  })
    .then((res) => {
      // Drain body so the socket is released, then record status.
      return res.text().catch(() => '').then(() => ({ ok: res.ok, status: res.status }));
    })
    .then(({ ok, status }) => recordDelivery(store, app, hook.id, { at: new Date().toISOString(), ok, status }))
    .catch((err) => recordDelivery(store, app, hook.id, { at: new Date().toISOString(), ok: false, status: 0, error: String(err.message || err).slice(0, 120) }))
    .finally(() => clearTimeout(timer));
}

function recordDelivery(store, app, hookId, delivery) {
  const app2 = store.getApp(app.id);
  if (!app2) return;
  const hook = (app2.hooks || []).find((h) => h.id === hookId);
  if (!hook) return;
  hook.lastDelivery = delivery;
  hook.deliveries = [delivery, ...(Array.isArray(hook.deliveries) ? hook.deliveries : [])].slice(0, 5);
  store.saveApp(app2);
}
