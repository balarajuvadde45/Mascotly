// Conversation memory: embeddings + RAG over the user's past turns.
//
// Backends:
//   redis — MASCOT_REDIS_URL (list per app, capped)   ← preferred in production
//   file  — <dataDir>/memory/<appId>.json             ← default, zero-config
//
// Recall: embed the query (when an embedding provider is configured) and rank
// by cosine similarity with a same-session boost; falls back to lexical token
// overlap when embeddings are unavailable, so memory works fully offline.
import fs from 'node:fs';
import path from 'node:path';
import { getRedis } from './redis.js';
import { getEmbedder } from './providers/embeddings.js';
import { config } from './config.js';
import { tokenize } from './knowledge/tokenize.js';
import { newId, nowIso } from './util.js';

const MAX_ENTRIES_PER_APP = 200;
const fileCache = new Map(); // appId -> entries (source of truth for the file backend)

function memoryFile(appId) {
  return path.join(config.dataDir, 'memory', `${appId}.json`);
}

function fileBackend(appId) {
  if (fileCache.has(appId)) return fileCache.get(appId);
  const entries = (() => {
    try {
      return JSON.parse(fs.readFileSync(memoryFile(appId), 'utf8')).entries || [];
    } catch {
      return [];
    }
  })();
  fileCache.set(appId, entries);
  return entries;
}

function persistFile(appId, entries) {
  fs.mkdirSync(path.dirname(memoryFile(appId)), { recursive: true });
  const tmp = memoryFile(appId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ entries }));
  try { fs.renameSync(tmp, memoryFile(appId)); } catch { fs.rmSync(memoryFile(appId), { force: true }); fs.renameSync(tmp, memoryFile(appId)); }
}

function backend() {
  const redis = getRedis();
  return redis ? 'redis' : 'file';
}

async function loadEntries(appId) {
  if (backend() === 'redis') {
    const redis = getRedis();
    try {
      const raw = await redis.lrange(`mascotly:mem:${appId}`, 0, -1);
      return raw.map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    } catch (err) {
      console.warn(`[memory] redis load failed, using local: ${err.message}`);
      return fileBackend(appId);
    }
  }
  return fileBackend(appId);
}

async function saveEntries(appId, entries) {
  const capped = entries.slice(0, MAX_ENTRIES_PER_APP);
  if (backend() === 'redis') {
    const redis = getRedis();
    try {
      const key = `mascotly:mem:${appId}`;
      await redis.del(key);
      for (const e of capped) await redis.lpush(key, JSON.stringify(e));
      await redis.ltrim(key, 0, MAX_ENTRIES_PER_APP - 1);
      return;
    } catch (err) {
      console.warn(`[memory] redis save failed, mirroring locally: ${err.message}`);
    }
  }
  fileCache.set(appId, capped);
  persistFile(appId, capped);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function lexicalOverlap(queryTokens, text) {
  const t = new Set(tokenize(text));
  let hits = 0;
  for (const tok of queryTokens) if (t.has(tok)) hits++;
  return queryTokens.length ? hits / queryTokens.length : 0;
}

/** Embed text (or null when no embedding provider is configured). */
async function embed(app, text) {
  try {
    const embedder = getEmbedder(app.settings?.embeddings || {});
    if (!embedder.configured) return null;
    const vecs = await embedder.embed([String(text).slice(0, 2000)]);
    return vecs?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Store a conversation turn in memory. Fire-and-forget safe.
 * @param {object} store
 * @param {object} app
 * @param {object} p { sessionId, role, text, summary? }
 */
export async function rememberTurn(store, app, { sessionId, role, text }) {
  try {
    const clean = String(text || '').trim();
    if (!clean || clean.length < 8) return 0;
    const entries = await loadEntries(app.id);
    const embedding = await embed(app, clean.slice(0, 1200));
    entries.unshift({
      id: newId('mem'),
      sessionId: String(sessionId || '').slice(0, 80),
      role: role === 'assistant' ? 'assistant' : 'user',
      text: clean.slice(0, 1200),
      embedding,
      at: nowIso(),
    });
    await saveEntries(app.id, entries);
    return 1;
  } catch (err) {
    console.warn(`[memory] rememberTurn failed: ${err.message}`);
    return 0;
  }
}

/**
 * Recall the most relevant past turns for a query.
 * @returns {Promise<Array<{text, sessionId, at, score}>>} up to k entries
 */
export async function recallMemory(store, app, { query, sessionId, k = 5 } = {}) {
  try {
    const entries = await loadEntries(app.id);
    if (!entries.length) return [];
    const qEmbedding = await embed(app, String(query || '').slice(0, 1200));
    const qTokens = tokenize(String(query || ''));
    const scored = entries.map((e) => {
      let score = 0;
      if (qEmbedding && Array.isArray(e.embedding)) score += cosine(qEmbedding, e.embedding) * 1.4;
      score += lexicalOverlap(qTokens, e.text) * 0.8;
      if (sessionId && e.sessionId === sessionId) score += 0.25;
      if (e.role === 'user') score += 0.1;
      return { text: e.text, sessionId: e.sessionId, at: e.at, role: e.role, score };
    });
    return scored
      .filter((s) => s.score > 0.08)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(k || 5, 10)));
  } catch (err) {
    console.warn(`[memory] recall failed: ${err.message}`);
    return [];
  }
}

/** Store a durable summary line produced by an LLM (from MEMORY_SUMMARY). */
export async function rememberSummary(store, app, { sessionId, summary }) {
  return rememberTurn(store, app, { sessionId, role: 'assistant', text: `Summary: ${summary}` });
}

export function memoryInfo() {
  return { backend: backend(), maxEntriesPerApp: MAX_ENTRIES_PER_APP };
}
