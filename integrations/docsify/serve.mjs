#!/usr/bin/env node
// Tiny zero-dependency static server for the docsify docs site.
//   node integrations/docsify/serve.mjs  [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, 'docs');
const PORT = Number(process.argv[2]) || 4321;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath)
      .on('error', () => res.destroy()) // read race / EACCES / EBUSY must not kill the server
      .pipe(res);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' }).end('Internal error');
  }
});

server.listen(PORT, () => {
  console.log(`Docsify docs (with embedded Mascotly) → http://localhost:${PORT}`);
  console.log('Make sure the Mascotly server is running (npm start) and seed.mjs was executed.');
});
