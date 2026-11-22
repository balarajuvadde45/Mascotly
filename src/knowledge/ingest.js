// Knowledge ingestion orchestrator.
//
// Sources (docs URLs, crawls, sitemaps, GitHub repos, pasted text, uploads,
// review dumps, REA findings) become structured knowledge chunks with metadata,
// optionally enriched with embeddings, stored per app.
import { chunkText, chunkReviews } from './chunker.js';
import {
  fetchPage, htmlToMarkdownLite, extractLinks, canFetch, fetchSitemapUrls, fetchGithubRepo,
} from './crawler.js';
import { getEmbedder } from '../providers/embeddings.js';
import { cleanText, newId, nowIso, truncate } from '../util.js';
import { config } from '../config.js';

export class KnowledgeLimitError extends Error {
  constructor(cap) {
    super(`Knowledge limit reached (max ${cap} chunks per app). Remove sources or raise MASCOT_MAX_CHUNKS.`);
    this.name = 'KnowledgeLimitError';
    this.code = 'knowledge_limit';
  }
}

export const SOURCE_TYPES = ['text', 'file', 'url', 'crawl', 'sitemap', 'github', 'reviews', 'rea'];

export function addSourceRecord(store, app, { type, label, detail = {} }) {
  if (!SOURCE_TYPES.includes(type)) throw new Error(`Unknown source type: ${type}`);
  const source = {
    id: newId('src'),
    type,
    label: truncate(String(label || type), 120),
    detail,
    status: 'pending',
    docCount: 0,
    chunkCount: 0,
    charCount: 0,
    error: null,
    createdAt: nowIso(),
    fetchedAt: null,
  };
  const sources = store.getSources(app.id);
  sources.push(source);
  store.saveSources(app.id, sources);
  return source;
}

export function updateSource(store, app, sourceId, patch) {
  const sources = store.getSources(app.id);
  const source = sources.find((s) => s.id === sourceId);
  if (!source) return null;
  Object.assign(source, patch);
  store.saveSources(app.id, sources);
  return source;
}

export function removeSource(store, app, sourceId) {
  const sources = store.getSources(app.id);
  const idx = sources.findIndex((s) => s.id === sourceId);
  if (idx === -1) return false;
  sources.splice(idx, 1);
  store.saveSources(app.id, sources);
  const chunks = store.getChunks(app.id).filter((c) => c.sourceId !== sourceId);
  store.saveChunks(app.id, chunks);
  app.stats.chunks = chunks.length;
  store.saveApp(app);
  return true;
}

/** Embed chunks that don't have vectors yet (no-op when no provider is configured). */
export async function embedChunks(app, chunks) {
  const embedder = getEmbedder(app.settings?.embeddings || {});
  if (!embedder.configured) return 0;
  const pending = chunks.filter((c) => !c.embedding);
  if (!pending.length) return 0;
  try {
    const vectors = await embedder.embed(pending.map((c) => c.text));
    if (!vectors) return 0;
    pending.forEach((c, i) => { c.embedding = vectors[i] || null; });
    return pending.length;
  } catch (err) {
    console.warn(`[ingest] Embedding failed for app ${app.id}: ${err.message}`);
    return 0;
  }
}

function buildChunks(docs, { reviews = false } = {}) {
  const out = [];
  for (const doc of docs) {
    const text = cleanText(doc.text);
    if (!text || text.length < 40) continue;
    const pieces = reviews ? chunkReviews(text) : chunkText(text);
    for (const piece of pieces) {
      out.push({
        text: piece.text,
        heading: piece.heading || doc.title || '',
        headingPath: piece.headingPath || doc.title || '',
        meta: {
          label: doc.label || '',
          title: doc.title || '',
          url: doc.url || '',
          kind: doc.kind || 'text',
          sourceType: doc.sourceType || 'text',
        },
      });
    }
  }
  return out;
}

function storeChunks(store, app, sourceId, chunks, { reviews = false } = {}) {
  const existing = store.getChunks(app.id);
  const kept = existing.filter((c) => c.sourceId !== sourceId);
  const cap = config.chunking.maxCharsPerApp;
  if (kept.length + chunks.length > cap) {
    throw new KnowledgeLimitError(cap);
  }
  const records = chunks.map((c) => ({
    id: newId('ch'),
    appId: app.id,
    sourceId,
    ord: c.ord ?? kept.length,
    text: c.text,
    heading: c.heading || '',
    headingPath: c.headingPath || '',
    meta: { ...c.meta, reviews: reviews || undefined },
    embedding: null,
    createdAt: nowIso(),
  }));
  const all = [...kept, ...records];
  store.saveChunks(app.id, all);
  app.stats.chunks = all.length;
  return { all, added: records.length };
}

/** Commit a set of raw docs for a source: chunk → embed → persist → update source record. */
export async function commitSource(store, app, source, docs, { reviews = false, extraDetail = {} } = {}) {
  const chunks = buildChunks(docs, { reviews });
  if (!chunks.length) {
    updateSource(store, app, source.id, {
      status: 'error',
      error: 'No usable content found (page empty, blocked, or JS-only render).',
      fetchedAt: nowIso(),
      ...extraDetail,
    });
    throw new Error('No usable content found at the given source. If this is a modern JS-rendered site, try a docs page URL, a GitHub repo, or paste the text directly.');
  }
  await embedChunks(app, chunks);
  let all;
  try {
    ({ all } = storeChunks(store, app, source.id, chunks, { reviews }));
  } catch (err) {
    // Keep the source record truthful (e.g. knowledge-limit rejection).
    updateSource(store, app, source.id, {
      status: 'error',
      error: truncate(String(err.message), 300),
      fetchedAt: nowIso(),
      ...extraDetail,
    });
    throw err;
  }
  const charCount = docs.reduce((s, d) => s + d.text.length, 0);
  updateSource(store, app, source.id, {
    status: 'ready',
    docCount: docs.length,
    chunkCount: chunks.length,
    charCount,
    error: null,
    fetchedAt: nowIso(),
    ...extraDetail,
  });
  app.stats.ingestedChars = (app.stats.ingestedChars || 0) + charCount;
  store.saveApp(app);
  return { chunkCount: chunks.length, docCount: docs.length, charCount, totalChunks: all.length };
}

// ---------- per-type ingestors ----------

const MAX_RESTORABLE_CHARS = 300_000;

export async function ingestText(store, app, { label = 'Pasted text', text, url = '', kind = 'text' }) {
  if (!String(text || '').trim()) throw new Error('Text is empty');
  // Keep the raw content on the source record so re-ingest works without re-submission.
  const detail = { url, chars: text.length };
  if (text.length <= MAX_RESTORABLE_CHARS) detail.text = text;
  const source = addSourceRecord(store, app, { type: kind === 'reviews' ? 'reviews' : 'text', label, detail });
  const commit = await commitSource(store, app, source, [{
    title: label,
    url,
    text,
    label,
    kind,
    sourceType: kind === 'reviews' ? 'reviews' : 'text',
  }], { reviews: kind === 'reviews' });
  return { sourceId: source.id, ...commit };
}

export function ingestReviewsText(store, app, { label = 'Reviews', text }) {
  return ingestText(store, app, { label, text, kind: 'reviews' });
}

export async function ingestFileContent(store, app, { label, content, encoding = 'text', mime = '' }) {
  let text = content;
  if (encoding === 'base64') {
    const buf = Buffer.from(content, 'base64');
    if (buf.length > config.limits.maxUploadChars) throw new Error('File too large');
    text = buf.toString('utf8');
    // Crude binary sniff: many NULs → unsupported.
    if (text.includes('\u0000')) throw new Error('Binary files are not supported — upload text/markdown/HTML/CSV');
  }
  if (!String(text || '').trim()) throw new Error('File is empty');
  const detail = { mime, encoding };
  if (text.length <= MAX_RESTORABLE_CHARS) detail.text = text;
  const source = addSourceRecord(store, app, { type: 'file', label: label || 'Uploaded file', detail });
  const commit = await commitSource(store, app, source, [{
    title: label,
    text,
    label: label || 'Uploaded file',
    kind: 'file',
    sourceType: 'file',
  }]);
  return { sourceId: source.id, ...commit };
}

export async function ingestUrl(store, app, { url, label = '', source } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must start with http(s)://');
  if (!(await canFetch(url))) throw new Error('Blocked by robots.txt');
  const res = await fetchPage(url);
  if (!res.ok) throw new Error(`Fetch failed with HTTP ${res.status}`);
  if (/text\/html|application\/xhtml/i.test(res.contentType)) {
    const { title, text } = htmlToMarkdownLite(res.body);
    const src = source || addSourceRecord(store, app, { type: 'url', label: label || title || url, detail: { url: res.url } });
    const commit = await commitSource(store, app, src, [{
      title: title || url, url: res.url, text, label: label || title || url, kind: 'docs', sourceType: 'url',
    }]);
    return { sourceId: src.id, ...commit };
  }
  // Non-HTML (text/plain, markdown, json...) — index as-is.
  const src = source || addSourceRecord(store, app, { type: 'url', label: label || url, detail: { url: res.url, contentType: res.contentType } });
  const commit = await commitSource(store, app, src, [{
    title: label || url, url: res.url, text: res.body, label: label || url, kind: 'docs', sourceType: 'url',
  }]);
  return { sourceId: src.id, ...commit };
}

export async function ingestCrawl(store, app, { url, maxPages, sameOrigin = true, source, deadline } = {}, onProgress = () => {}) {
  const start = new URL(url);
  const cap = Math.min(Number(maxPages) || config.crawl.maxPages, 50);
  const src = source || addSourceRecord(store, app, { type: 'crawl', label: `Crawl: ${start.hostname}${start.pathname === '/' ? '' : truncate(start.pathname, 40)}`, detail: { url, maxPages: cap, sameOrigin } });

  const visited = new Set();
  const queue = [{ url: url.toString(), depth: 0 }];
  const docs = [];
  const startedAt = Date.now();
  const budget = deadline || (config.serverless ? Date.now() + 45_000 : Infinity);

  while (queue.length && docs.length < cap) {
    if (Date.now() > budget) {
      onProgress('time budget reached — stopping crawl early', 90);
      break;
    }
    const { url: current, depth } = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    onProgress(`crawl ${docs.length + 1}/${cap}: ${truncate(current, 60)}`, Math.round((docs.length / cap) * 80));
    if (!(await canFetch(current))) continue;
    let res;
    try {
      res = await fetchPage(current);
    } catch {
      continue;
    }
    if (!res.ok || !/text\/html/i.test(res.contentType)) continue;
    const { title, text } = htmlToMarkdownLite(res.body);
    if (text.length > 200) {
      docs.push({ title: title || current, url: current, text, label: `Crawl: ${start.hostname}`, kind: 'docs', sourceType: 'crawl' });
    }
    if (depth < 2) {
      for (const link of extractLinks(res.body, current)) {
        if (docs.length + queue.length >= cap + 10) break;
        if (visited.has(link)) continue;
        const u = new URL(link);
        if (sameOrigin && u.origin !== start.origin) continue;
        // Stay near doc-ish pages; skip obvious assets.
        if (/\.(png|jpe?g|gif|svg|pdf|zip|mp4|woff2?|css|js|ico)$/i.test(u.pathname)) continue;
        queue.push({ url: link, depth: depth + 1 });
      }
    }
  }
  const commit = await commitSource(store, app, src, docs, { extraDetail: { pagesCrawled: docs.length } });
  return { sourceId: src.id, ...commit };
}

export async function ingestSitemap(store, app, { url, maxUrls, source, deadline } = {}, onProgress = () => {}) {
  const cap = Math.min(Number(maxUrls) || 20, 60);
  onProgress('resolving sitemap…', 5);
  const urls = await fetchSitemapUrls(url, cap);
  if (!urls.length) throw new Error('No URLs found in sitemap');
  const src = source || addSourceRecord(store, app, { type: 'sitemap', label: `Sitemap: ${truncate(url, 80)}`, detail: { url, discovered: urls.length } });
  const docs = [];
  const budget = deadline || (config.serverless ? Date.now() + 45_000 : Infinity);
  for (let i = 0; i < urls.length; i++) {
    if (Date.now() > budget) {
      onProgress('time budget reached — stopping sitemap fetch early', 90);
      break;
    }
    onProgress(`fetch ${i + 1}/${urls.length}: ${truncate(urls[i], 60)}`, Math.round(((i + 1) / urls.length) * 80));
    if (!(await canFetch(urls[i]))) continue;
    try {
      const res = await fetchPage(urls[i]);
      if (!res.ok) continue;
      const { title, text } = htmlToMarkdownLite(res.body);
      if (text.length > 200) {
        docs.push({ title: title || urls[i], url: urls[i], text, label: `Sitemap: ${url}`, kind: 'docs', sourceType: 'sitemap' });
      }
    } catch { /* skip page */ }
  }
  const commit = await commitSource(store, app, src, docs, { extraDetail: { pagesFetched: docs.length } });
  return { sourceId: src.id, ...commit };
}

export async function ingestGithub(store, app, { repo, branch, source, token } = {}, onProgress = () => {}) {
  onProgress('looking up repository…', 5);
  const { meta, files } = await fetchGithubRepo(repo, { branch, token });
  if (!files.length) throw new Error('No readable markdown files found in the repo (is it public?)');
  const src = source || addSourceRecord(store, app, {
    type: 'github',
    label: `GitHub: ${meta.fullName}`,
    detail: { repo: meta.fullName, branch: meta.defaultBranch, stars: meta.stars, topics: meta.topics, homepage: meta.homepage },
  });
  const docs = files.map((f) => ({
    title: `${meta.fullName}/${f.path}`,
    url: `https://github.com/${meta.fullName}/blob/${meta.defaultBranch}/${f.path}`,
    text: f.text,
    label: `GitHub: ${meta.fullName}`,
    kind: 'docs',
    sourceType: 'github',
  }));
  // Repo metadata as its own small doc — description/topics/homepage feed the analyzer.
  docs.unshift({
    title: `${meta.fullName} (repo overview)`,
    url: `https://github.com/${meta.fullName}`,
    text: [
      `Repository: ${meta.fullName}`,
      meta.description ? `Description: ${meta.description}` : '',
      meta.language ? `Primary language: ${meta.language}` : '',
      meta.homepage ? `Homepage: ${meta.homepage}` : '',
      meta.topics?.length ? `Topics: ${meta.topics.join(', ')}` : '',
      meta.stars != null ? `Stars: ${meta.stars}` : '',
    ].filter(Boolean).join('\n'),
    label: `GitHub: ${meta.fullName}`,
    kind: 'meta',
    sourceType: 'github',
  });
  const commit = await commitSource(store, app, src, docs, { extraDetail: { files: files.length } });
  return { sourceId: src.id, ...commit };
}
