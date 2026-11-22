// PostgreSQL storage adapter — production mode for teams that want their
// Mascotly state in a real database (multi-tenant tracking, SQL analytics,
// joins with existing user systems). Same synchronous surface as the KV/file
// stores: eager preload at init, memory-first reads, debounced upserts.
//
// Schema (auto-created):
//   mascotly_state(key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ)
// Keys:
//   admin · registry · app:<appId> (blob: { id, app, sources, chunks, profile, sessions })
//
// Env: MASCOT_DATABASE_URL or DATABASE_URL (e.g. postgresql://user:pass@localhost:5432/db)
// Requires the `pg` package (installed as an optional peer of this adapter).

import { buildAppRecord } from './app-record.js';
import { newId, nowIso, secretKey } from './util.js';

export class PgStore {
  constructor({ connectionString, prefix = 'mascotly:', waitUntil } = {}) {
    this.connectionString = connectionString
      || process.env.MASCOT_DATABASE_URL
      || process.env.DATABASE_URL
      || '';
    this.prefix = prefix;
    this.waitUntil = waitUntil || null;
    if (!this.connectionString) {
      throw new Error('PgStore requires MASCOT_DATABASE_URL or DATABASE_URL');
    }
    this._initialized = false;
    this._initPromise = null;
    this._admin = null;
    this._registry = { apps: [] };
    this._blobs = new Map();
    this._dirtyBlobs = new Set();
    this._dirtyRegistry = false;
    this._dirtyAdmin = false;
    this._deletedBlobs = new Set();
    this._flushPromise = null;
    this._flushTimer = null;
    this._pool = null;
  }

  async _poolReady() {
    if (this._pool) return this._pool;
    let mod;
    try {
      mod = await import('pg');
    } catch {
      throw new Error('Postgres store needs the "pg" package — run: npm install pg');
    }
    this._pool = new mod.Pool({ connectionString: this.connectionString, max: 5 });
    return this._pool;
  }

  async _query(text, params = []) {
    const pool = await this._poolReady();
    return pool.query(text, params);
  }

  async init() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const pool = await this._poolReady();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mascotly_state (
          key TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      const { rows } = await pool.query('SELECT key, value FROM mascotly_state');
      for (const row of rows) {
        if (row.key === this.k('admin')) this._admin = row.value;
        else if (row.key === this.k('registry')) this._registry = row.value || { apps: [] };
        else if (row.key.startsWith(this.k('app:'))) this._blobs.set(row.key.slice(this.k('app:').length), row.value);
      }
      this._registry = this._registry && Array.isArray(this._registry.apps) ? this._registry : { apps: [] };
      this._registry.apps = this._registry.apps.filter((a) => {
        const b = this._blobs.get(a.id);
        return b && b.app;
      });
      if (!this._admin) {
        this._admin = { key: secretKey(24), createdAt: new Date().toISOString() };
        this._dirtyAdmin = true;
        await this.flushNow();
      }
      this._initialized = true;
    })();
    try {
      await this._initPromise;
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  k(suffix) { return `${this.prefix}${suffix}`; }

  _schedule() {
    if (this._flushPromise) return;
    this._flushPromise = new Promise((resolve) => { this._flushTimer = setTimeout(resolve, 250); });
    const flushTask = this._flushPromise
      .then(() => this.flushNow())
      .catch((err) => {
        console.error('[store-pg] flush failed (data re-queued):', err.message);
        this._schedule();
      });
    if (typeof this.waitUntil === 'function') {
      try { this.waitUntil(flushTask); } catch { /* best effort */ }
    }
  }

  async flushNow() {
    this._flushPromise = null;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    const upserts = [];
    if (this._dirtyAdmin && this._admin) upserts.push([this.k('admin'), this._admin]);
    if (this._dirtyRegistry) upserts.push([this.k('registry'), this._registry]);
    for (const id of this._dirtyBlobs) {
      const blob = this._blobs.get(id);
      if (blob) upserts.push([this.k(`app:${id}`), blob]);
    }
    const dels = [...this._deletedBlobs].map((id) => this.k(`app:${id}`));
    if (!upserts.length && !dels.length) return;
    try {
      for (const [key, value] of upserts) {
        await this._query(
          `INSERT INTO mascotly_state (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, JSON.stringify(value)]
        );
      }
      for (const key of dels) {
        await this._query('DELETE FROM mascotly_state WHERE key = $1', [key]);
      }
      this._dirtyAdmin = false;
      this._dirtyRegistry = false;
      this._dirtyBlobs.clear();
      this._deletedBlobs.clear();
    } catch (err) {
      throw err; // dirty state preserved; _schedule() re-queues
    }
  }

  async flushAll() { await this.flushNow(); }

  _markBlob(id) { this._dirtyBlobs.add(id); this._schedule(); }

  // The public surface mirrors UpstashStore exactly.
  ensureAdminKey() { return this._admin; }
  getRegistry() { return this._registry; }
  saveRegistry(reg) { this._registry = reg; this._dirtyRegistry = true; this._schedule(); }
  listApps() {
    return this._registry.apps
      .map((e) => this.getApp(e.id))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
  _blob(appId) { return this._blobs.get(appId) || null; }

  createApp(opts) {
    const record = buildAppRecord(opts, { id: newId('app') });
    this._blobs.set(record.id, { id: record.id, app: record, sources: [], chunks: [], profile: null, sessions: {} });
    this._registry.apps.push({ id: record.id, slug: record.slug, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt });
    this._dirtyRegistry = true;
    this._markBlob(record.id);
    return record;
  }
  getApp(appId) {
    const blob = this._blob(appId);
    return blob && blob.app ? blob.app : null;
  }
  saveApp(app) {
    app.updatedAt = new Date().toISOString();
    const blob = this._blob(app.id);
    if (!blob) return;
    blob.app = app;
    this._markBlob(app.id);
    const entry = this._registry.apps.find((a) => a.id === app.id);
    if (entry) { entry.name = app.name; entry.slug = app.slug || entry.slug; entry.updatedAt = app.updatedAt; this._dirtyRegistry = true; }
  }
  deleteApp(appId) {
    this._blobs.delete(appId);
    this._deletedBlobs.add(appId);
    this._registry.apps = this._registry.apps.filter((a) => a.id !== appId);
    this._dirtyRegistry = true;
    this._schedule();
  }
  getSources(appId) { const b = this._blob(appId); return b ? b.sources : []; }
  saveSources(appId, sources) { const b = this._blob(appId); if (!b) return; b.sources = sources; this._markBlob(appId); }
  getChunks(appId) { const b = this._blob(appId); return b ? b.chunks : []; }
  saveChunks(appId, chunks) { const b = this._blob(appId); if (!b) return; b.chunks = chunks; this._markBlob(appId); }
  getProfile(appId) { const b = this._blob(appId); return b ? b.profile : null; }
  saveProfile(appId, profile) { const b = this._blob(appId); if (!b) return; b.profile = profile; this._markBlob(appId); }
  listSessions(appId) {
    const b = this._blob(appId);
    if (!b) return [];
    const out = [];
    for (const s of Object.values(b.sessions || {})) {
      if (!s || !s.id || typeof s !== 'object') continue;
      out.push({
        id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt,
        messageCount: s.messages?.length || 0, escalated: !!s.escalated,
        page: s.page || null, preview: s.messages?.[0]?.content?.slice(0, 140) || '',
      });
    }
    out.sort((a, b2) => (a.updatedAt < b2.updatedAt ? 1 : -1));
    return out;
  }
  getSession(appId, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return null;
    const b = this._blob(appId);
    if (!b || !b.sessions) return null;
    return Object.hasOwn(b.sessions, sessionId) ? b.sessions[sessionId] : null;
  }
  saveSession(appId, session) {
    session.updatedAt = new Date().toISOString();
    const b = this._blob(appId);
    if (!b) return;
    if (!b.sessions || typeof b.sessions !== 'object') b.sessions = {};
    b.sessions[session.id] = session;
    this._markBlob(appId);
  }
  deleteSession(appId, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return false;
    const b = this._blob(appId);
    if (!b) return false;
    if (Object.hasOwn(b.sessions || {}, sessionId)) {
      delete b.sessions[sessionId];
      this._markBlob(appId);
    }
    return true;
  }
}

// The app-record shape is shared across all stores — import from the file store
// module lazily to avoid duplication drift.
