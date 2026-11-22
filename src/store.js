// File-backed storage engine.
//
// Layout:
//   <dataDir>/admin.json                     { key, createdAt }
//   <dataDir>/registry.json                  { apps: [{id, slug, name, createdAt, updatedAt}] }
//   <dataDir>/apps/<appId>/app.json          full app record (config, keys, settings, stats)
//   <dataDir>/apps/<appId>/sources.json      knowledge sources
//   <dataDir>/apps/<appId>/chunks.json       indexed knowledge chunks
//   <dataDir>/apps/<appId>/profile.json      analyzer output (app understanding)
//   <dataDir>/apps/<appId>/sessions/<sid>.json
//
// All writes are atomic (tmp + rename) and debounced; flushAll() drains on shutdown.
import fs from 'node:fs';
import path from 'node:path';
import { newId, nowIso, secretKey } from './util.js';
import { buildAppRecord } from './app-record.js';

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(`[store] Failed to read ${file}: ${err.message}`);
  }
  return fallback;
}

class DebouncedWriter {
  constructor() {
    this.timers = new Map(); // file -> timeout
    this.pending = new Map(); // file -> data
    this.flushing = new Set();
  }

  schedule(file, data, delayMs = 200) {
    this.pending.set(file, data);
    if (this.timers.has(file)) clearTimeout(this.timers.get(file));
    const t = setTimeout(() => this.flushFile(file), delayMs);
    // Do not keep the event loop alive just for pending writes.
    t.unref?.();
    this.timers.set(file, t);
  }

  flushFile(file) {
    if (this.flushing.has(file)) return;
    const data = this.pending.get(file);
    this.timers.delete(file);
    if (data === undefined) return;
    this.flushing.add(file);
    try {
      this.pending.delete(file);
      writeJsonAtomic(file, data);
    } catch (err) {
      console.error(`[store] Failed to write ${file}: ${err.message}`);
      // Re-queue once so data is not silently lost.
      if (!this.pending.has(file)) this.pending.set(file, data);
    } finally {
      this.flushing.delete(file);
    }
  }

  flushAll() {
    for (const file of [...this.pending.keys()]) this.flushFile(file);
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Some filesystems (and some Windows states) refuse rename-over-existing.
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.writer = new DebouncedWriter();
    this.registryFile = path.join(dataDir, 'registry.json');
    this.adminFile = path.join(dataDir, 'admin.json');
    this._apps = new Map(); // appId -> app.json contents (cache)
    this._sources = new Map();
    this._chunks = new Map();
    this._profiles = new Map();
    fs.mkdirSync(path.join(dataDir, 'apps'), { recursive: true });
  }

  // ---------- admin ----------
  ensureAdminKey() {
    const existing = readJson(this.adminFile, null);
    if (existing?.key) return existing;
    const rec = { key: secretKey(24), createdAt: nowIso() };
    writeJsonAtomic(this.adminFile, rec);
    return rec;
  }

  // ---------- registry ----------
  getRegistry() {
    return readJson(this.registryFile, { apps: [] });
  }

  saveRegistry(reg) {
    writeJsonAtomic(this.registryFile, reg);
  }

  listApps() {
    const reg = this.getRegistry();
    return reg.apps
      .map((e) => this.getApp(e.id))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  // ---------- apps ----------
  appDir(appId) {
    // Basic path-safety: ids are generated server-side, but validate anyway.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw new Error('Invalid app id');
    return path.join(this.dataDir, 'apps', appId);
  }

  createApp(opts) {
    const record = buildAppRecord(opts, { id: newId('app') });
    writeJsonAtomic(path.join(this.appDir(record.id), 'app.json'), record);
    const reg = this.getRegistry();
    reg.apps.push({ id: record.id, slug: record.slug, name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt });
    this.saveRegistry(reg);
    this._apps.set(record.id, record);
    return record;
  }

  getApp(appId) {
    if (this._apps.has(appId)) return this._apps.get(appId);
    const rec = readJson(path.join(this.appDir(appId), 'app.json'), null);
    if (rec) this._apps.set(appId, rec);
    return rec;
  }

  saveApp(app) {
    app.updatedAt = nowIso();
    this._apps.set(app.id, app);
    this.writer.schedule(path.join(this.appDir(app.id), 'app.json'), app);
    const reg = this.getRegistry();
    const entry = reg.apps.find((a) => a.id === app.id);
    if (entry) {
      entry.name = app.name;
      entry.slug = app.slug || entry.slug;
      entry.updatedAt = app.updatedAt;
      this.writer.schedule(this.registryFile, reg);
    }
  }

  deleteApp(appId) {
    this._apps.delete(appId);
    this._sources.delete(appId);
    this._chunks.delete(appId);
    this._profiles.delete(appId);
    fs.rmSync(this.appDir(appId), { recursive: true, force: true });
    const reg = this.getRegistry();
    reg.apps = reg.apps.filter((a) => a.id !== appId);
    this.saveRegistry(reg);
  }

  // ---------- sources / chunks / profile ----------
  getSources(appId) {
    if (this._sources.has(appId)) return this._sources.get(appId);
    const list = readJson(path.join(this.appDir(appId), 'sources.json'), []);
    this._sources.set(appId, list);
    return list;
  }

  saveSources(appId, sources) {
    this._sources.set(appId, sources);
    this.writer.schedule(path.join(this.appDir(appId), 'sources.json'), sources);
  }

  getChunks(appId) {
    if (this._chunks.has(appId)) return this._chunks.get(appId);
    const list = readJson(path.join(this.appDir(appId), 'chunks.json'), []);
    this._chunks.set(appId, list);
    return list;
  }

  saveChunks(appId, chunks) {
    this._chunks.set(appId, chunks);
    this.writer.schedule(path.join(this.appDir(appId), 'chunks.json'), chunks, 400);
  }

  getProfile(appId) {
    if (this._profiles.has(appId)) return this._profiles.get(appId);
    const p = readJson(path.join(this.appDir(appId), 'profile.json'), null);
    if (p) this._profiles.set(appId, p);
    return p;
  }

  saveProfile(appId, profile) {
    this._profiles.set(appId, profile);
    writeJsonAtomic(path.join(this.appDir(appId), 'profile.json'), profile);
  }

  // ---------- sessions ----------
  sessionsDir(appId) {
    return path.join(this.appDir(appId), 'sessions');
  }

  listSessions(appId) {
    const dir = this.sessionsDir(appId);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const s = readJson(path.join(dir, f), null);
      if (s) {
        out.push({
          id: s.id,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages?.length || 0,
          escalated: !!s.escalated,
          page: s.page || null,
          preview: s.messages?.[0]?.content?.slice(0, 140) || '',
        });
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  getSession(appId, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return null;
    return readJson(path.join(this.sessionsDir(appId), `${sessionId}.json`), null);
  }

  saveSession(appId, session) {
    session.updatedAt = nowIso();
    writeJsonAtomic(path.join(this.sessionsDir(appId), `${session.id}.json`), session);
  }

  deleteSession(appId, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return false;
    const file = path.join(this.sessionsDir(appId), `${sessionId}.json`);
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  flushAll() {
    this.writer.flushAll();
  }
}
