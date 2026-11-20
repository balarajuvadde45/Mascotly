// Embedding providers. When none is configured the retriever transparently uses
// sparse TF-IDF cosine vectors computed locally (see retriever.js), so the whole
// product works offline.
import { resolveEmbeddingsSettings } from '../config.js';
import { truncate } from '../util.js';

const MAX_BATCH = 64;

async function postJson(url, body, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = truncate(await res.text().catch(() => ''), 200);
      throw new Error(`Embedding request failed (${res.status}): ${detail}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class OpenAiCompatibleEmbedder {
  constructor(s) {
    this.provider = s.provider;
    this.model = s.model;
    this.baseUrl = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = s.apiKey || '';
    this.dimensions = s.dimensions || undefined;
    this.configured = true;
  }

  async embed(texts) {
    const out = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH).map((t) => String(t).slice(0, 8000));
      const body = { model: this.model, input: batch };
      if (this.dimensions) body.dimensions = this.dimensions;
      const data = await postJson(`${this.baseUrl}/embeddings`, body,
        this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {});
      const rows = (data?.data || [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding);
      if (rows.length !== batch.length) throw new Error('Embedding response count mismatch');
      out.push(...rows);
    }
    return out;
  }
}

class OllamaEmbedder {
  constructor(s) {
    this.provider = 'ollama';
    this.model = s.model;
    this.baseUrl = (s.baseUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.configured = true;
  }

  async embed(texts) {
    const out = [];
    for (const t of texts) {
      const data = await postJson(`${this.baseUrl}/api/embeddings`, {
        model: this.model,
        prompt: String(t).slice(0, 8000),
      });
      if (!Array.isArray(data?.embedding)) throw new Error('Ollama embedding response missing');
      out.push(data.embedding);
    }
    return out;
  }
}

class NullEmbedder {
  constructor() {
    this.provider = 'none';
    this.configured = false;
  }
  async embed() {
    return null; // retriever falls back to local TF-IDF vectors
  }
}

export function createEmbedder(settings) {
  switch (settings.provider) {
    case 'openai':
    case 'openai-compatible':
    case 'groq':
    case 'mistral':
      return new OpenAiCompatibleEmbedder(settings);
    case 'ollama': return new OllamaEmbedder(settings);
    default: return new NullEmbedder();
  }
}

export function getEmbedder(appOverride) {
  const s = resolveEmbeddingsSettings(appOverride?.embeddings || {});
  return createEmbedder(s);
}
