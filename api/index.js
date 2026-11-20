// Vercel serverless entry point.
//
// vercel.json rewrites /api/* to this function; static assets (landing page,
// dashboard, widget) are served from public/ by Vercel's static layer.
// Storage defaults to the Upstash/Vercel-KV adapter on Vercel (file storage is
// impossible there) — see docs/self-hosting.md for the env vars to set.
import { createStore } from '../src/store-factory.js';
import { createServer } from '../src/server.js';

const store = await createStore();
const app = createServer(store);
let ready = null;

export default async function handler(req, res) {
  // Storage cold-start (Upstash preload); FileStore has no init().
  if (!ready) {
    ready = typeof store.init === 'function' ? store.init() : Promise.resolve();
  }
  try {
    await ready;
  } catch (err) {
    // Allow the next invocation to retry a transient storage failure.
    ready = null;
    res.status(500).json({ error: 'storage_init_failed', message: String(err.message || err) });
    return;
  }

  // Some mount styles strip the /api prefix; restore it so express routes match.
  if (typeof req.url === 'string' && !req.url.startsWith('/api')) {
    req.url = `/api${req.url === '/' ? '' : req.url}`;
  } else if (req.url === '/api/index') {
    // Direct invocation of the function file — normalize to the API root.
    req.url = '/api';
  }
  return app(req, res);
}
