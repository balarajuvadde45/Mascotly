// Postgres store adapter — runs against the local DATABASE_URL when reachable,
// otherwise skips gracefully (CI without a database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

const DATABASE_URL = process.env.MASCOT_DATABASE_URL
  || process.env.DATABASE_URL
  || 'postgresql://postgres:sdlc_ardberg@localhost:5432/attendance';

function pgReachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 2500 });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

test('PG store: full lifecycle against a live Postgres (skips when unreachable)', async (t) => {
  const u = new URL(DATABASE_URL);
  const reachable = await pgReachable(u.hostname, Number(u.port) || 5432);
  if (!reachable) {
    t.skip('Postgres not reachable at ' + u.host);
    return;
  }

  process.env.MASCOT_DATABASE_URL = DATABASE_URL;
  const { PgStore } = await import('../src/store-pg.js');
  const sharedPrefix = 'mascotly:test:' + Date.now() + ':'; // SAME prefix across instances
  const pgStore = new PgStore({ connectionString: DATABASE_URL, prefix: sharedPrefix });
  await pgStore.init();
  const admin1 = pgStore.ensureAdminKey();
  assert.ok(admin1.key.length >= 24, 'admin key generated');

  const app = pgStore.createApp({ name: 'PG Lifecycle', description: 'db test' });
  pgStore.saveSources(app.id, [{ id: 'src_pg', type: 'text', label: 'L' }]);
  pgStore.saveChunks(app.id, [{ id: 'ch_pg', text: 'pg chunk', sourceId: 'src_pg' }]);
  pgStore.saveProfile(app.id, { summary: 'pg profile' });
  pgStore.saveSession(app.id, { id: 'ses_pg', createdAt: 't', updatedAt: 't', messages: [{ role: 'user', content: 'hi' }] });
  pgStore.saveApp(pgStore.getApp(app.id));
  await pgStore.flushNow();

  // fresh instance sees everything
  const store2 = new PgStore({ connectionString: DATABASE_URL, prefix: sharedPrefix });
  await store2.init();
  assert.equal(store2.getApp(app.id).name, 'PG Lifecycle');
  assert.equal(store2.getChunks(app.id).length, 1);
  assert.equal(store2.getProfile(app.id).summary, 'pg profile');
  assert.ok(store2.getSession(app.id, 'ses_pg'));
  assert.equal(store2.listApps().length, 1);
  assert.equal(store2.ensureAdminKey().key, admin1.key);

  store2.deleteApp(app.id);
  await store2.flushNow();
  const store3 = new PgStore({ connectionString: DATABASE_URL, prefix: sharedPrefix });
  await store3.init();
  assert.equal(store3.getApp(app.id), null);
});
