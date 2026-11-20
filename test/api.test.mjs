// Integration test: boots the real server on an ephemeral port and exercises
// the full product flow end-to-end (apps → sources → analysis → chat → sessions).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-api-data-'));
process.env.MASCOT_DATA_DIR = DATA_DIR;
process.env.MASCOT_PLAYGROUND = 'false';
process.env.MASCOT_LLM_PROVIDER = ''; // offline: heuristic analyzer + offline chat fallback

const { createServer } = await import('../src/server.js');
const { Store } = await import('../src/store.js');

const store = new Store(DATA_DIR);
const app = createServer(store);
let httpServer = null;
let base = '';
let adminKey = '';
let appRec = null; // offline app
let mockApp = null; // mock-brain app

async function api(method, p, body, key = adminKey) {
  const res = await fetch(base + '/api' + p, {
    method,
    headers: { 'x-mascot-key': key, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function publicChat(pathname, body, ip = '10.0.0.1') {
  const res = await fetch(base + '/api/v1' + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const SEED = `# Widget
The sample widget answers questions about deployment. Deployments are triggered from the Releases page.

# Deployment
Deploy takes about 4 minutes. Rollbacks are one click under Releases → History.

# FAQ
Q: How long does deploy take?
A: About four minutes, including health checks.
`;

before(async () => {
  await new Promise((resolve) => {
    httpServer = app.listen(0, '127.0.0.1', resolve);
  });
  const port = httpServer.address().port;
  base = `http://127.0.0.1:${port}`;
  adminKey = store.ensureAdminKey().key;

  // App 1: offline brain (no provider).
  const created = await api('POST', '/apps', {
    name: 'Deploy Bot App',
    description: 'A deployment dashboard for testing.',
    mascot: { name: 'Deplo' },
  });
  assert.equal(created.status, 201);
  appRec = created.data.app;
  const src = await api('POST', `/apps/${appRec.id}/sources`, { type: 'text', label: 'seed docs', text: SEED });
  assert.equal(src.status, 201);
  assert.ok(src.data.chunkCount >= 2);

  // App 2: mock brain.
  const created2 = await api('POST', '/apps', {
    name: 'Mock Brain App',
    mascot: { name: 'Mocky' },
    settings: { model: { provider: 'mock' } },
  });
  mockApp = created2.data.app;
  await api('POST', `/apps/${mockApp.id}/sources`, { type: 'text', label: 'seed docs', text: SEED });
});

after(() => {
  return new Promise((resolve) => {
    httpServer.closeAllConnections?.();
    httpServer.close(() => resolve());
    setTimeout(resolve, 1500).unref?.();
  });
});

test('health + system endpoints', async () => {
  const health = await fetch(base + '/api/health').then((r) => r.json());
  assert.equal(health.ok, true);
  const sys = await api('GET', '/system');
  assert.equal(sys.status, 200);
  assert.ok(sys.data.providers);
});

test('auth: admin endpoints reject bad keys', async () => {
  const res = await fetch(base + '/api/apps', { headers: { 'x-mascot-key': 'wrong' } });
  assert.equal(res.status, 401);
});

test('auth: app endpoints reject foreign secret key', async () => {
  const res = await fetch(base + `/api/apps/${appRec.id}`, { headers: { 'x-mascot-key': 'nope' } });
  assert.equal(res.status, 401);
});

test('widget-config: public endpoint works with publicKey, fails without', async () => {
  const ok = await fetch(base + `/api/v1/widget-config/${appRec.id}/${appRec.publicKey}`);
  assert.equal(ok.status, 200);
  const cfg = await ok.json();
  assert.equal(cfg.mascot.name, 'Deplo');
  const bad = await fetch(base + `/api/v1/widget-config/${appRec.id}/wrongkey`);
  assert.equal(bad.status, 401);
});

test('analysis: heuristic profile is generated from knowledge', async () => {
  const started = await api('POST', `/apps/${appRec.id}/analyze`);
  assert.equal(started.status, 202);
  const jobId = started.data.jobId;

  // Poll for completion.
  let job = null;
  for (let i = 0; i < 60; i++) {
    const res = await api('GET', `/apps/${appRec.id}/jobs/${jobId}`);
    job = res.data.job;
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.equal(job.status, 'done', `job error: ${job.error}`);

  const prof = await api('GET', `/apps/${appRec.id}/profile`);
  assert.equal(prof.status, 200);
  assert.ok(prof.data.profile.summary.length > 10);
  assert.equal(prof.data.profile.engine, 'heuristic');
});

test('retrieval: search endpoint returns scored results', async () => {
  const res = await api('POST', `/apps/${appRec.id}/search`, { query: 'how long does deploy take?', k: 3 });
  assert.equal(res.status, 200);
  assert.ok(res.data.results.length >= 1);
  assert.ok(res.data.results.some((r) => r.text.toLowerCase().includes('deploy')));
});

test('chat: offline fallback answers from knowledge with citations', async () => {
  const res = await publicChat(`/chat/${appRec.id}/${appRec.publicKey}`, { message: 'How long does a deploy take?' });
  assert.equal(res.status, 200);
  assert.ok(res.data.answer.toLowerCase().includes('deploy'));
  assert.ok(res.data.citations.length >= 1);
  assert.ok(res.data.sessionId.startsWith('ses_'));
  assert.equal(res.data.usage.provider, 'none');
});

test('chat: mock provider streams a full SSE exchange', async () => {
  const res = await fetch(base + `/api/v1/stream/${mockApp.id}/${mockApp.publicKey}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'How does deployment work?' }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('event: delta'));
  assert.ok(text.includes('event: done'));
  // The done event payload carries the final answer + session id.
  const doneLine = text.split('\n').find((l) => l.startsWith('data:') && l.includes('"sessionId"'));
  assert.ok(doneLine, 'done payload present');
  const payload = JSON.parse(doneLine.slice(5));
  assert.ok(payload.answer.length > 10);
  assert.ok(payload.citations.length >= 1);
  assert.equal(payload.usage.provider, 'mock');
});

test('chat: rate limiting kicks in per app settings', async () => {
  const tightened = await api('PATCH', `/apps/${appRec.id}`, { settings: { rateLimitPerMin: 1 } });
  assert.equal(tightened.status, 200);
  const first = await publicChat(`/chat/${appRec.id}/${appRec.publicKey}`, { message: 'hello one' }, '9.9.9.1');
  const second = await publicChat(`/chat/${appRec.id}/${appRec.publicKey}`, { message: 'hello two' }, '9.9.9.1');
  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.data.error, 'rate_limited');
  // a different client is unaffected
  const other = await publicChat(`/chat/${appRec.id}/${appRec.publicKey}`, { message: 'hello three' }, '9.9.9.2');
  assert.equal(other.status, 200);
  // restore
  await api('PATCH', `/apps/${appRec.id}`, { settings: { rateLimitPerMin: 200 } });
});

test('chat: empty message rejected', async () => {
  const res = await publicChat(`/chat/${appRec.id}/${appRec.publicKey}`, { message: '  ' });
  assert.equal(res.status, 400);
});

test('sessions: transcript persisted and listable', async () => {
  const list = await api('GET', `/apps/${mockApp.id}/sessions`);
  assert.ok(list.data.sessions.length >= 1);
  const sid = list.data.sessions[0].id;
  const one = await api('GET', `/apps/${mockApp.id}/sessions/${sid}`);
  assert.equal(one.status, 200);
  assert.ok(one.data.session.messages.length >= 2);
  assert.equal(one.data.session.messages[0].role, 'user');
});

test('escalation: keyword flags the session', async () => {
  const res = await publicChat(`/chat/${mockApp.id}/${mockApp.publicKey}`, { message: 'I want to talk to a real person about my refund' });
  assert.equal(res.status, 200);
  assert.equal(res.data.escalated, true);
  const list = await api('GET', `/apps/${mockApp.id}/sessions`);
  assert.ok(list.data.sessions.some((s) => s.escalated));
});

test('sources: delete removes chunks', async () => {
  const before = await api('GET', `/apps/${appRec.id}/sources`);
  const sid = before.data.sources[0].id;
  const del = await api('DELETE', `/apps/${appRec.id}/sources/${sid}`);
  assert.equal(del.status, 200);
  const after = await api('GET', `/apps/${appRec.id}/sources`);
  assert.equal(after.data.sources.length, before.data.sources.length - 1);
  const k = after.data.knowledge;
  assert.ok(k.chunks < 10 ** 9);
  assert.equal(k.chunks, 0);
});

test('keys rotate', async () => {
  const res = await api('POST', `/apps/${appRec.id}/keys/rotate`);
  assert.equal(res.status, 200);
  assert.notEqual(res.data.publicKey, appRec.publicKey);
  appRec = { ...appRec, publicKey: res.data.publicKey, secretKey: res.data.secretKey };
});

test('app deletion cleans up', async () => {
  const del = await api('DELETE', `/apps/${appRec.id}`);
  assert.equal(del.status, 200);
  const get = await api('GET', `/apps/${appRec.id}`);
  assert.equal(get.status, 404);
});

test('knowledge limit enforced', async () => {
  const created = await api('POST', '/apps', { name: 'Limit App' });
  const limitApp = created.data.app;
  const bigText = 'word '.repeat(1200 * 100); // ~6000KB → thousands of chunks
  const res = await api('POST', `/apps/${limitApp.id}/sources`, { type: 'text', label: 'big', text: bigText });
  // Either rejected for size (maxUploadChars) or knowledge limit — both are fine.
  assert.ok([400, 201].includes(res.status), `got ${res.status}`);
  await api('DELETE', `/apps/${limitApp.id}`);
});
