// Upstash/Vercel-KV store adapter test against a fake REST server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { UpstashStore } from '../src/store-upstash.js';

let storeData = new Map(); // key -> value (JSON string, like real SET/GET over Upstash REST)
let fakeServer = null;

function startFakeKv() {
  fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url !== '/pipeline') {
        res.writeHead(404).end();
        return;
      }
      try {
        const commands = JSON.parse(body);
        const results = commands.map((cmd) => {
          const [op, key, value] = cmd;
          if (op === 'get') {
            const v = storeData.get(key);
            return { result: v === undefined ? null : v };
          }
          if (op === 'set') {
            storeData.set(key, value);
            return { result: 'OK' };
          }
          if (op === 'del') {
            storeData.delete(key);
            return { result: 1 };
          }
          return { error: 'unsupported op' };
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(results));
      } catch (err) {
        res.writeHead(400).end(JSON.stringify({ error: String(err.message) }));
      }
    });
  });
  return new Promise((resolve) => fakeServer.listen(0, '127.0.0.1', () => resolve(fakeServer)));
}

test.after(() => {
  if (fakeServer) {
    fakeServer.close();
    fakeServer.closeAllConnections?.();
  }
  storeData.clear();
});

test('KV store: cold start preload, writes, persistence across instances', async () => {
  const server = await startFakeKv();
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  // Instance 1: init (generates admin key), create app, write data.
  const store1 = new UpstashStore({ url, token: 'test-token', waitUntil: null });
  await store1.init();
  const admin1 = store1.ensureAdminKey();
  assert.ok(admin1.key.length >= 24);

  const app = store1.createApp({ name: 'KV Test', description: 'd' });
  store1.saveSources(app.id, [{ id: 'src_1', type: 'text', label: 'L' }]);
  store1.saveChunks(app.id, [{ id: 'ch_1', text: 'hello', sourceId: 'src_1' }]);
  store1.saveProfile(app.id, { summary: 'kv profile' });
  store1.saveSession(app.id, { id: 'ses_1', createdAt: 't', updatedAt: 't', messages: [{ role: 'user', content: 'hi' }] });
  store1.getApp(app.id).stats.messages = 3;
  store1.saveApp(store1.getApp(app.id));
  // ensure the debounced flush lands
  await store1.flushNow();

  // Regression (P0): a SECOND write cycle must also persist via the debounce —
  // the flush scheduling has to re-arm after every flush, not just the first.
  store1.saveSession(app.id, { id: 'ses_2', createdAt: 't2', updatedAt: 't2', messages: [] });
  await new Promise((r) => setTimeout(r, 400)); // debounce window + flush

  // Instance 2: fresh cold start must see everything.
  const store2 = new UpstashStore({ url, token: 'test-token', waitUntil: null });
  await store2.init();
  const loaded = store2.getApp(app.id);
  assert.ok(loaded, 'app blob persisted');
  assert.equal(loaded.name, 'KV Test');
  assert.equal(loaded.stats.messages, 3);
  assert.equal(store2.getSources(app.id)[0].id, 'src_1');
  assert.equal(store2.getChunks(app.id).length, 1);
  assert.equal(store2.getProfile(app.id).summary, 'kv profile');
  assert.ok(store2.getSession(app.id, 'ses_1'));
  assert.ok(store2.getSession(app.id, 'ses_2'), 'second write cycle must persist (flush re-arms)');
  assert.equal(store2.listSessions(app.id).length, 2);
  assert.equal(store2.listApps().length, 1);
  assert.equal(store2.ensureAdminKey().key, admin1.key, 'admin key shared across instances');

  // Prototype-pollution guard: ids that match the id regex but collide with
  // Object.prototype members must never resolve.
  assert.equal(store2.getSession(app.id, 'constructor'), null);
  assert.equal(store2.getSession(app.id, '__proto__'), null);

  // Delete round-trips too.
  store2.deleteApp(app.id);
  await store2.flushNow();
  const store3 = new UpstashStore({ url, token: 'test-token', waitUntil: null });
  await store3.init();
  assert.equal(store3.getApp(app.id), null);
  assert.equal(store3.listApps().length, 0);

  server.close();
  server.closeAllConnections?.();
});

test('KV store: rejects missing credentials', () => {
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    assert.throws(() => new UpstashStore({}), /requires UPSTASH_REDIS_REST_URL/);
  } finally {
    if (savedUrl) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
    if (savedTok) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
  }
});
