// App-level knowledge service: cached retriever per app + query embedding helper.
import { Retriever } from './retriever.js';
import { getEmbedder } from '../providers/embeddings.js';
import { tokenize } from './tokenize.js';

const retrieverCache = new Map(); // appId -> { ref, retriever, builtAt }

export function getAppRetriever(store, app) {
  const chunks = store.getChunks(app.id);
  const hit = retrieverCache.get(app.id);
  if (hit && hit.ref === chunks) return hit.retriever;
  const retriever = new Retriever(chunks);
  retrieverCache.set(app.id, { ref: chunks, retriever, builtAt: Date.now() });
  return retriever;
}

export function invalidateRetriever(appId) {
  retrieverCache.delete(appId);
}

export async function embedQuery(app, query) {
  const embedder = getEmbedder(app.settings?.embeddings || {});
  if (!embedder.configured) return null;
  try {
    const vecs = await embedder.embed([String(query).slice(0, 2000)]);
    return vecs?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Search an app's knowledge.
 * @returns {Promise<Array<{chunk, score, bm25, cosine}>>}
 */
export async function searchApp(store, app, query, k) {
  const retriever = getAppRetriever(store, app);
  if (!retriever.size) return [];
  const queryEmbedding = await embedQuery(app, query);
  return retriever.search(query, {
    k: k || 6,
    queryEmbedding,
  });
}

export function knowledgeStats(store, app) {
  const chunks = store.getChunks(app.id);
  const sources = store.getSources(app.id);
  const byStatus = { ready: 0, pending: 0, error: 0 };
  let chars = 0;
  for (const s of sources) byStatus[s.status] = (byStatus[s.status] || 0) + 1;
  for (const c of chunks) chars += c.text.length;
  return {
    chunks: chunks.length,
    chars,
    sources: { total: sources.length, ...byStatus },
    embedded: chunks.some((c) => Array.isArray(c.embedding) && c.embedding.length),
  };
}

export { tokenize };
