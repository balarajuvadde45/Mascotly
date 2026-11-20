// Express app factory.
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { config, ROOT_DIR } from './config.js';
import { corsLite, errorHandler, HttpError } from './routes/middleware.js';
import { buildApiRouter } from './routes/apps.js';
import { buildChatRouter } from './routes/chat.js';

export function createServer(store) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: config.limits.maxBodyBytes }));
  app.use((err, req, res, next) => {
    // Body-parser errors (malformed JSON / too large) → clean 400.
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(400).json({ error: 'bad_request', message: err.type === 'entity.too.large' ? 'Request body too large' : 'Malformed JSON body' });
    }
    next(err);
  });

  // Lightweight request log for admin endpoints only.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/') && !req.path.startsWith('/api/v1/')) {
      res.on('finish', () => {
        if (res.statusCode >= 400) console.log(`[api] ${req.method} ${req.path} → ${res.statusCode}`);
      });
    }
    next();
  });

  app.use('/api', corsLite, buildApiRouter(store));
  app.use('/api/v1', corsLite, buildChatRouter(store));

  // Static assets: landing page, dashboard, widget, demo page.
  const publicDir = path.join(ROOT_DIR, 'public');
  app.use(express.static(publicDir, {
    maxAge: '1h',
    setHeaders(res, filePath) {
      // HTML must always revalidate (ETag) — stale landing/dashboard pages are worse
      // than a cheap conditional request.
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  // Example apps (dev convenience).
  if (config.serveExamples) {
    const examplesDir = path.join(ROOT_DIR, 'examples');
    if (fs.existsSync(examplesDir)) {
      app.use('/examples', express.static(examplesDir, { maxAge: 0 }));
    }
  }

  // JSON 404 for unknown API routes; friendly 404 elsewhere.
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) return next(new HttpError(404, 'Unknown API route', 'not_found'));
    res.status(404).sendFile(path.join(publicDir, '404.html'), (err) => {
      if (err) res.status(404).send('Not found');
    });
  });

  app.use(errorHandler);
  return app;
}
