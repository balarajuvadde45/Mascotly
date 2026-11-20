// Upstash / Vercel-KV REST storage adapter.
//
// Serverless platforms (Vercel, etc.) have no persistent filesystem, so the
// file store cannot be used there. This adapter keeps the exact same
// synchronous Store API the rest of the codebase relies on by:
//   1. eagerly loading ALL state into memory on cold start (one REST roundtrip
//      per collection, one pipeline for app blobs), and
//   2. treating memory as the source of truth during the request, flushing
//      dirty writes through the Upstash REST pipeline inside `waitUntil()` so
//      writes complete after the response is sent.
//
// Key layout (prefix configurable via MASCOT_KV_PREFIX, default "mascot:"):
//   <prefix>registry        { apps: [{id, slug, name, createdAt, updatedAt}] }
//   <prefix>admin           { key, createdAt }
//   <prefix>app:<appId>     { id, app, sources, chunks, profile, sessions: {sid: session} }
//
// Environment:
//   MASCOT_STORE=upstash (or auto-detected on Vercel)
//   UPSTASH_REDIS_REST_URL  /  KV_REST_API_URL      (Vercel KV injects the latter)
//   UPSTASH_REDIS_REST_TOKEN / KV_REST_API_TOKEN
//   MASCOT_KV_PREFIX (default "mascot:")
import { newId, nowIso, slugify, secretKey } from './util.js';

function pickEnv(...names) {
  for (const n of names) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

function getWaitUntil() {
  try {
    // @vercel/functions (optional dependency in practice; guarded import).
    // eslint-disable-next-line no-new-func
    const mod = globalThis.__mascotWaitUntil;
    if (mod) return mod;
  } catch { /* noop */ }
  return null;
}

export class UpstashStore {
  constructor({ url, token, prefix = 'mascot:', waitUntil } = {}) {
    this.url = (url || pickEnv('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'MASCOT_KV_REST_URL')).replace(/\/+$/, '');
    this.token = token || pickEnv('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'MASCOT_KV_REST_TOKEN');
    let prefixStr = prefix || 'mascot:';
    if (!prefixStr.endsWith(':')) prefixStr += ':';
    this.prefix = prefixStr;
    this.waitUntil = waitUntil || getWaitUntil();
    if (!this.url || !this.token) {
      throw new Error('Upstash store requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN from Vercel KV)');
    }
    if (!this.waitUntil) {
      console.warn('[store-upstash] waitUntil is unavailable — debounced flushes are fire-and-forget. On serverless platforms this can lose writes after the response; provide waitUntil (via @vercel/functions) or flush explicitly.');
    }
    this._initialized = false;
    this._initPromise = null;
    this._admin = null;
    this._registry = { apps: [] };
    this._blobs = new Map(); // appId -> blob
    this._dirtyBlobs = new Set();
    this._dirtyRegistry = false;
    this._dirtyAdmin = false;
    this._deletedBlobs = new Set();
    this._flushPromise = null;
    this._flushTimer = null;
  }

  // ---------- REST plumbing ----------

  async _pipeline(commands) {
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`KV pipeline failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('KV pipeline returned unexpected shape');
    // Upstash reports per-command failures on the row itself.
    for (const row of data) {
      if (row && row.error) throw new Error(`KV command failed: ${String(row.error).slice(0, 200)}`);
    }
    return data.map((row) => row?.result);
  }

  key(suffix) {
    return `${this.prefix}${suffix}`;
  }

  // ---------- lifecycle ----------

  /** Upstash REST may return strings (raw SET) or parsed objects depending on
   *  the backend/version — normalize defensively. */
  static _parse(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }

  async init() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      const [admin, registry] = await this._pipeline([
        ['get', this.key('admin')],
        ['get', this.key('registry')],
      ]);
      this._admin = UpstashStore._parse(admin);
      const parsedRegistry = UpstashStore._parse(registry);
      this._registry = parsedRegistry && typeof parsedRegistry === 'object' && Array.isArray(parsedRegistry.apps)
        ? parsedRegistry
        : { apps: [] };
      const ids = this._registry.apps.map((a) => a.id);
      if (ids.length) {
        const rows = await this._pipeline(ids.map((id) => ['get', this.key(`app:${id}`)]));
        ids.forEach((id, i) => {
          const blob = UpstashStore._parse(rows[i]);
          if (blob && typeof blob === 'object' && blob.id === id && blob.app) {
            this._blobs.set(id, this._reviveBlob(blob));
          }
          // Missing/corrupt blobs: do NOT insert placeholders — drop the registry
          // entry so zombies cannot accumulate or be resurrected.
        });
        this._registry.apps = this._registry.apps.filter((a) => {
          const b = this._blobs.get(a.id);
          return b && b.app;
        });
      }
      if (!this._admin) {
        this._admin = { key: secretKey(24), createdAt: nowIso() };
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

  /** Schedule a debounced flush; under waitUntil runtimes the work outlives the response. */
  _schedule() {
    if (this._flushPromise) return;
    this._flushPromise = new Promise((resolve) => {
      this._flushTimer = setTimeout(resolve, 250);
    });
    const flushTask = this._flushPromise
      .then(() => this.flushNow())
      .catch((err) => {
        console.error('[store-upstash] flush failed (data re-queued):', err.message);
        // Re-queue: dirty state was restored by flushNow, schedule the next cycle.
        this._schedule();
      });
    if (typeof this.waitUntil === 'function') {
      try { this.waitUntil(flushTask); } catch { /* context gone; best effort */ }
    } else {
      // Outside waitUntil runtimes, keep the event loop alive briefly for the flush.
      flushTask.catch(() => {});
    }
  }

  /** Compact chunk embeddings into base64 Float32 for storage (~4x smaller). */
  _compactBlob(blob) {
    const out = { ...blob };
    if (Array.isArray(out.chunks)) {
      out.chunks = out.chunks.map((c) => {
        if (!Array.isArray(c.embedding) || !c.embedding.length) return c;
        const buf = Buffer.allocUnsafe(c.embedding.length * 4);
        for (let i = 0; i < c.embedding.length; i++) buf.writeFloatLE(c.embedding[i], i * 4);
        return { ...c, embeddingB64: buf.toString('base64'), embedding: undefined };
      });
      for (const c of out.chunks) if (c && c.embedding === undefined) delete c.embedding;
    }
    return out;
  }

  _reviveBlob(blob) {
    const out = { ...blob };
    if (Array.isArray(out.chunks)) {
      out.chunks = out.chunks.map((c) => {
        if (!c || !c.embeddingB64) return c;
        try {
          const buf = Buffer.from(c.embeddingB64, 'base64');
          const vec = new Array(buf.length / 4);
          for (let i = 0; i < vec.length; i++) vec[i] = buf.readFloatLE(i * 4);
          const revived = { ...c, embedding: vec };
          delete revived.embeddingB64;
          return revived;
        } catch {
          return c;
        }
      });
    }
    return out;
  }

  async flushNow() {
    // Clear the cycle FIRST so mutations arriving during the pipeline schedule
    // the next flush (the debounce must re-arm for every cycle, not just one).
    this._flushPromise = null;
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }

    const commands = [];
    if (this._dirtyAdmin && this._admin) commands.push(['set', this.key('admin'), JSON.stringify(this._admin)]);
    if (this._dirtyRegistry) commands.push(['set', this.key('registry'), JSON.stringify(this._registry)]);
    for (const id of this._dirtyBlobs) {
      const blob = this._blobs.get(id);
      if (blob) commands.push(['set', this.key(`app:${id}`), JSON.stringify(this._compactBlob(blob))]);
    }
    for (const id of this._deletedBlobs) commands.push(['del', this.key(`app:${id}`)]);

    if (!commands.length) return;
    try {
      await this._pipeline(commands);
      // Only clear dirty state after a verified-successful pipeline.
      this._dirtyAdmin = false;
      this._dirtyRegistry = false;
      this._dirtyBlobs.clear();
      this._deletedBlobs.clear();
    } catch (err) {
      // Dirty state stays intact — _schedule() re-queues via the flushTask catch.
      throw err;
    }
  }

  async flushAll() {
    await this.flushNow();
  }

  _markBlob(id) {
    this._dirtyBlobs.add(id);
    this._schedule();
  }

  // ---------- admin ----------

  ensureAdminKey() {
    return this._admin;
  }

  // ---------- registry / apps ----------

  getRegistry() {
    return this._registry;
  }

  saveRegistry(reg) {
    this._registry = reg;
    this._dirtyRegistry = true;
    this._schedule();
  }

  listApps() {
    return this._registry.apps
      .map((e) => this.getApp(e.id))
      .filter(Boolean)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  _blob(appId) {
    return this._blobs.get(appId) || null;
  }

  createApp({ name, description = '', mascot = {}, settings = {} }) {
    const id = newId('app');
    const slug = slugify(name);
    const record = {
      id,
      slug,
      name,
      description,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      publicKey: secretKey(16),
      secretKey: secretKey(24),
      mascot: {
        name: mascot.name || 'Mottie',
        emoji: mascot.emoji || '🤖',
        color: mascot.color || '#6c5ce7',
        greeting: mascot.greeting || `Hi! I'm ${mascot.name || 'Mottie'} — ask me anything about this app.`,
        tagline: mascot.tagline || 'AI assistant',
        personality: mascot.personality || 'friendly, concise and helpful. You keep answers short and use markdown lists when helpful.',
        welcome: mascot.welcome ?? true,
        suggestions: Array.isArray(mascot.suggestions) ? mascot.suggestions.slice(0, 6) : [],
        actions: Array.isArray(mascot.actions) ? mascot.actions.slice(0, 12) : [],
        avatarUrl: mascot.avatarUrl || '',
        position: mascot.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
        telemetryOff: !!mascot.telemetryOff,
      },
      settings: {
        rateLimitPerMin: Number.isFinite(settings.rateLimitPerMin) ? settings.rateLimitPerMin : 20,
        allowedOrigins: Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : [],
        escalationKeywords: Array.isArray(settings.escalationKeywords) && settings.escalationKeywords.length
          ? settings.escalationKeywords
          : ['human', 'real person', 'support ticket', 'complain', 'refund', 'cancel account'],
        autoAnalyze: settings.autoAnalyze !== false,
        systemPromptExtra: String(settings.systemPromptExtra || ''),
        ...(settings.model && typeof settings.model === 'object' ? {
          model: {
            provider: String(settings.model.provider || 'auto').slice(0, 40),
            baseUrl: String(settings.model.baseUrl || '').slice(0, 300),
            model: String(settings.model.model || '').slice(0, 120),
            apiKey: String(settings.model.apiKey || '').slice(0, 300),
          },
        } : {}),
        ...(settings.embeddings && typeof settings.embeddings === 'object' ? {
          embeddings: {
            provider: String(settings.embeddings.provider || 'none').slice(0, 40),
            baseUrl: String(settings.embeddings.baseUrl || '').slice(0, 300),
            model: String(settings.embeddings.model || '').slice(0, 120),
            apiKey: String(settings.embeddings.apiKey || '').slice(0, 300),
          },
        } : {}),
      },
      skills: [],   // SKILL.md-compatible capability packs (agentskills.io format)
      tools: [],    // HTTP tool plugins callable by the mascot mid-chat
      hooks: [],    // signed lifecycle webhooks (message/escalation/feedback)
      stats: { messages: 0, sessions: 0, chunks: 0, ingestedChars: 0, lastChatAt: null, lastAnalyzedAt: null },
      jobs: [],
    };
    this._blobs.set(id, { id, app: record, sources: [], chunks: [], profile: null, sessions: {} });
    this._registry.apps.push({ id, slug, name, createdAt: record.createdAt, updatedAt: record.updatedAt });
    this._dirtyRegistry = true;
    this._markBlob(id);
    return record;
  }

  getApp(appId) {
    const blob = this._blob(appId);
    return blob && blob.app ? blob.app : null;
  }

  saveApp(app) {
    app.updatedAt = nowIso();
    const blob = this._blob(app.id);
    if (!blob) return;
    blob.app = app;
    this._markBlob(app.id);
    const entry = this._registry.apps.find((a) => a.id === app.id);
    if (entry) {
      entry.name = app.name;
      entry.slug = app.slug || entry.slug;
      entry.updatedAt = app.updatedAt;
      this._dirtyRegistry = true;
    }
  }

  deleteApp(appId) {
    this._blobs.delete(appId);
    this._deletedBlobs.add(appId);
    this._registry.apps = this._registry.apps.filter((a) => a.id !== appId);
    this._dirtyRegistry = true;
    this._schedule();
  }

  // ---------- sources / chunks / profile ----------

  getSources(appId) {
    const blob = this._blob(appId);
    return blob ? blob.sources : [];
  }

  saveSources(appId, sources) {
    const blob = this._blob(appId);
    if (!blob) return;
    blob.sources = sources;
    this._markBlob(appId);
  }

  getChunks(appId) {
    const blob = this._blob(appId);
    return blob ? blob.chunks : [];
  }

  saveChunks(appId, chunks) {
    const blob = this._blob(appId);
    if (!blob) return;
    blob.chunks = chunks;
    this._markBlob(appId);
  }

  getProfile(appId) {
    const blob = this._blob(appId);
    return blob ? blob.profile : null;
  }

  saveProfile(appId, profile) {
    const blob = this._blob(appId);
    if (!blob) return;
    blob.profile = profile;
    this._markBlob(appId);
  }

  // ---------- sessions ----------

  listSessions(appId) {
    const blob = this._blob(appId);
    if (!blob) return [];
    const out = [];
    for (const s of Object.values(blob.sessions)) {
      if (!s || !s.id || typeof s !== 'object') continue;
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
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  getSession(appId, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return null;
    const blob = this._blob(appId);
    if (!blob || !blob.sessions) return null;
    // hasOwn guards against ids like "constructor"/"__proto__" hitting
    // Object.prototype members (a 500 / prototype-pollution vector).
    return Object.hasOwn(blob.sessions, sessionId) ? blob.sessions[sessionId] : null;
  }

  saveSession(appId, session) {
    session.updatedAt = nowIso();
    const blob = this._blob(appId);
    if (!blob) return;
    if (!blob.sessions || typeof blob.sessions !== 'object') blob.sessions = {};
    blob.sessions[session.id] = session;
    this._markBlob(appId);
  }

  deleteSession(appId, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return false;
    const blob = this._blob(appId);
    if (!blob) return false;
    // Idempotent like the file store: report success when the app exists,
    // even if the session was already gone.
    if (Object.hasOwn(blob.sessions || {}, sessionId)) {
      delete blob.sessions[sessionId];
      this._markBlob(appId);
    }
    return true;
  }
}
