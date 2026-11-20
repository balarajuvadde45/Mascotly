// Hybrid retriever: BM25 (always) fused via reciprocal rank fusion (RRF) with a
// cosine-similarity ranking when vector embeddings exist (local sparse TF-IDF or
// remote embeddings).
import { tokenize } from './tokenize.js';

const K1 = 1.5;
const B = 0.75;
const RRF_K = 60;

function cosineSparse(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, w] of small) {
    const w2 = large.get(t);
    if (w2 !== undefined) dot += w * w2;
  }
  for (const w of a.values()) na += w * w;
  for (const w of b.values()) nb += w * w;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Sparse TF-IDF vector (top `maxTerms` terms by weight). */
function tfidfVector(tokens, idf, maxTerms = 160) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  const vec = new Map();
  for (const [t, f] of tf) {
    const idfVal = idf.get(t);
    if (idfVal === undefined) continue; // unseen in corpus
    vec.set(t, (1 + Math.log(f)) * idfVal);
  }
  if (vec.size > maxTerms) {
    const entries = [...vec.entries()].sort((x, y) => y[1] - x[1]).slice(0, maxTerms);
    return new Map(entries);
  }
  return vec;
}

export class Retriever {
  /**
   * @param {Array<{id,text,embedding?,sourceId,heading,headingPath}>} chunks
   */
  constructor(chunks) {
    this.chunks = chunks.filter((c) => c && typeof c.text === 'string' && c.text.trim());
    this.docs = this.chunks.map((c) => {
      const tokens = tokenize(`${c.headingPath || ''} ${c.text}`);
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
      return { chunk: c, tf, len: tokens.length || 1, tokens };
    });
    // Document frequency + idf.
    this.df = new Map();
    for (const d of this.docs) {
      for (const t of d.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    }
    const N = Math.max(1, this.docs.length);
    this.N = this.docs.length;
    this.idf = new Map();
    for (const [t, freq] of this.df) {
      this.idf.set(t, Math.log(1 + (N - freq + 0.5) / (freq + 0.5)));
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / N;
    // Local sparse TF-IDF vectors as embedding fallback (only when no dense vectors exist).
    const hasDense = this.docs.some((d) => Array.isArray(d.chunk.embedding) && d.chunk.embedding.length);
    this.localVectors = null;
    if (!hasDense && this.docs.length) {
      this.localVectors = this.docs.map((d) => tfidfVector(d.tokens, this.idf));
    }
  }

  get size() {
    return this.docs.length;
  }

  bm25Scores(queryTokens) {
    const scores = new Array(this.docs.length).fill(0);
    for (const t of queryTokens) {
      const idf = this.idf.get(t);
      if (idf === undefined) continue;
      for (let i = 0; i < this.docs.length; i++) {
        const d = this.docs[i];
        const f = d.tf.get(t);
        if (!f) continue;
        const denom = f + K1 * (1 - B + B * (d.len / this.avgLen));
        scores[i] += idf * ((f * (K1 + 1)) / denom);
      }
    }
    return scores;
  }

  /** Dense cosine ranking when chunks carry real embeddings; query must already be embedded. */
  denseScores(queryVec) {
    if (!queryVec || !Array.isArray(queryVec)) return null;
    const scores = new Array(this.docs.length).fill(-1);
    for (let i = 0; i < this.docs.length; i++) {
      const e = this.docs[i].chunk.embedding;
      if (!Array.isArray(e) || e.length !== queryVec.length) continue;
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let j = 0; j < e.length; j++) {
        dot += e[j] * queryVec[j];
        na += e[j] * e[j];
        nb += queryVec[j] * queryVec[j];
      }
      scores[i] = na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    }
    return scores;
  }

  localScores(queryTokens) {
    if (!this.localVectors) return null;
    const qv = tfidfVector(queryTokens, this.idf);
    if (!qv.size) return null;
    const scores = new Array(this.docs.length).fill(0);
    for (let i = 0; i < this.docs.length; i++) {
      scores[i] = cosineSparse(qv, this.localVectors[i]);
    }
    return scores;
  }

  /**
   * Hybrid search.
   * @param {string} query
   * @param {object} opts { k, queryEmbedding, minScore }
   * @returns {Array<{chunk, score, bm25, cosine, rank}>}
   */
  search(query, opts = {}) {
    const k = Math.max(1, Math.min(opts.k || 6, 50));
    if (!this.docs.length) return [];
    const queryTokens = tokenize(`${opts.headingBoost || ''} ${query}`);
    const bm25 = this.bm25Scores(queryTokens);

    const dense = this.denseScores(opts.queryEmbedding);
    const local = dense ? null : this.localScores(queryTokens);

    // Build ranked lists (indices, best first).
    const order = (scores, pred = (v) => v > 0) => scores
      .map((s, i) => [s, i])
      .filter(([s]) => pred(s))
      .sort((a, b) => b[0] - a[0])
      .map(([, i]) => i);

    const bm25List = order(bm25);
    let secondList = [];
    if (dense) secondList = order(dense, (v) => v > 0.02);
    else if (local) secondList = order(local, (v) => v > 0.02);

    // Reciprocal rank fusion.
    const fused = new Map();
    bm25List.forEach((idx, rank) => {
      fused.set(idx, (fused.get(idx) || 0) + 1 / (RRF_K + rank + 1));
    });
    secondList.forEach((idx, rank) => {
      fused.set(idx, (fused.get(idx) || 0) + 1 / (RRF_K + rank + 1));
    });
    if (!fused.size) {
      // Fall back to pure bm25 ordering (zero-score included) so the agent can
      // still answer "I don't know" with context, and FAQs stay reachable.
      bm25List.push(...order(new Array(this.docs.length).fill(0), () => true).slice(0, 2));
      return bm25List.slice(0, k).map((idx, rank) => ({
        chunk: this.docs[idx].chunk,
        score: 0,
        bm25: 0,
        cosine: null,
        rank: rank + 1,
      }));
    }

    const ranked = [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k * 2);

    return ranked
      .map(([idx, score], rank) => ({
        chunk: this.docs[idx].chunk,
        score,
        bm25: bm25[idx],
        cosine: dense ? dense[idx] : (local ? local[idx] : null),
        rank: rank + 1,
      }))
      .filter((r) => opts.minScore === undefined || r.score >= opts.minScore)
      .slice(0, k);
  }
}

/** Build a short citation snippet centered on query terms when possible. */
export function makeSnippet(text, queryTokens = [], maxLen = 220) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const lower = clean.toLowerCase();
  let best = 0;
  let bestHits = -1;
  const step = Math.max(1, Math.floor((clean.length - maxLen) / 8));
  for (let start = 0; start <= clean.length - maxLen; start += step) {
    const window = lower.slice(start, start + maxLen);
    let hits = 0;
    for (const t of queryTokens) {
      if (window.includes(t)) hits++;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = start;
    }
  }
  const prefix = best > 0 ? '…' : '';
  const suffix = best + maxLen < clean.length ? '…' : '';
  return prefix + clean.slice(best, best + maxLen) + suffix;
}
