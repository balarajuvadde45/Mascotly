// Storage factory: picks the right Store implementation for the runtime.
//   file    (default)   — atomic JSON files; local dev, Docker, VPS, any Node host
//   upstash / kv        — Upstash/Vercel-KV REST adapter; serverless platforms
// Auto-detects Vercel (env VERCEL) unless MASCOT_STORE overrides explicitly.
import { config } from './config.js';
import { Store as FileStore } from './store.js';
import { UpstashStore } from './store-upstash.js';

export async function createStore() {
  const raw = String(process.env.MASCOT_STORE || config.store || (process.env.VERCEL ? 'upstash' : 'file'));
  const kind = raw.toLowerCase();

  if (kind === 'upstash' || kind === 'kv' || kind === 'vercel-kv' || kind === 'redis') {
    let waitUntil = null;
    try {
      // Official helper: keeps flush work alive after the response on Vercel.
      // Non-Vercel runtimes fall back to fire-and-forget inside the helper.
      const mod = await import('@vercel/functions');
      waitUntil = mod.waitUntil;
    } catch {
      waitUntil = null; // flushed eagerly instead
    }
    return new UpstashStore({ prefix: config.kvPrefix, waitUntil });
  }
  return new FileStore(config.dataDir);
}
