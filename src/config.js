// Configuration: environment variables overlaid on an optional mascot.config.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

function readConfigFile() {
  const candidates = [
    process.env.MASCOT_CONFIG,
    path.join(ROOT_DIR, 'mascot.config.json'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      }
    } catch (err) {
      console.warn(`[config] Ignoring unreadable config file ${file}: ${err.message}`);
    }
  }
  return {};
}

const file = readConfigFile();

function pick(...candidates) {
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

function intVal(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function boolVal(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const env = process.env;

export const config = {
  port: intVal(pick(env.MASCOT_PORT, env.PORT, file.port), 4242),
  host: pick(env.MASCOT_HOST, file.host) || '0.0.0.0',
  dataDir: path.resolve(ROOT_DIR, pick(env.MASCOT_DATA_DIR, file.dataDir) || 'data'),
  rootDir: ROOT_DIR,

  // Storage backend: "file" (persistent hosts) or "upstash"/"kv" (serverless).
  // Auto-detects Vercel when unset.
  store: (pick(env.MASCOT_STORE, file.store) || (env.VERCEL ? 'upstash' : 'file')).toLowerCase(),
  kvPrefix: pick(env.MASCOT_KV_PREFIX, file.kvPrefix) || 'mascot:',
  // Serverless mode: run ingest/analysis inline within the request instead of
  // detached background jobs (serverless functions cannot outlive the request).
  serverless: boolVal(pick(env.MASCOT_SERVERLESS, file.serverless), !!env.VERCEL),

  // Admin/master key. If empty, one is generated into <dataDir>/admin.json on boot.
  adminKey: pick(env.MASCOT_ADMIN_KEY, file.adminKey) || '',

  llm: {
    provider: (pick(env.MASCOT_LLM_PROVIDER, file.llm?.provider) || 'auto').toLowerCase(),
    baseUrl: pick(env.MASCOT_LLM_BASE_URL, file.llm?.baseUrl) || '',
    model: pick(env.MASCOT_LLM_MODEL, file.llm?.model) || '',
    apiKey: pick(env.MASCOT_LLM_API_KEY, file.llm?.apiKey) || '',
    temperature: parseFloat(pick(env.MASCOT_LLM_TEMPERATURE, file.llm?.temperature)) || 0.4,
    maxTokens: intVal(pick(env.MASCOT_LLM_MAX_TOKENS, file.llm?.maxTokens), 1200),
    maxHistoryMessages: intVal(pick(env.MASCOT_MAX_HISTORY, file.llm?.maxHistoryMessages), 16),
    requestTimeoutMs: intVal(pick(env.MASCOT_LLM_TIMEOUT, file.llm?.requestTimeoutMs), 60000),
  },

  embeddings: {
    provider: (pick(env.MASCOT_EMBEDDINGS_PROVIDER, file.embeddings?.provider) || 'none').toLowerCase(),
    baseUrl: pick(env.MASCOT_EMBEDDINGS_BASE_URL, file.embeddings?.baseUrl) || '',
    model: pick(env.MASCOT_EMBEDDINGS_MODEL, file.embeddings?.model) || 'text-embedding-3-small',
    apiKey: pick(env.MASCOT_EMBEDDINGS_API_KEY, file.embeddings?.apiKey) || '',
    dimensions: intVal(pick(env.MASCOT_EMBEDDINGS_DIMENSIONS, file.embeddings?.dimensions), 0),
  },

  rea: {
    // "auto" detects `rea` on PATH then falls back to `npx -y rea-agents@latest`.
    command: pick(env.MASCOT_REA_COMMAND, file.rea?.command) || 'auto',
    timeoutMs: intVal(pick(env.MASCOT_REA_TIMEOUT, file.rea?.timeoutMs), 300000),
    maxOutputBytes: intVal(pick(env.MASCOT_REA_MAX_OUTPUT, file.rea?.maxOutputBytes), 4_000_000),
  },

  crawl: {
    userAgent: pick(env.MASCOT_CRAWLER_UA, file.crawl?.userAgent)
      || 'MascotlyBot/0.1 (+https://github.com/morluto/mascot; docs indexer)',
    timeoutMs: intVal(pick(env.MASCOT_CRAWL_TIMEOUT, file.crawl?.timeoutMs), 20000),
    maxPages: intVal(pick(env.MASCOT_CRAWL_MAX_PAGES, file.crawl?.maxPages), 15),
    maxCharsPerPage: intVal(pick(env.MASCOT_CRAWL_MAX_CHARS, file.crawl?.maxCharsPerPage), 120_000),
  },

  retrieval: {
    topK: intVal(pick(env.MASCOT_TOP_K, file.retrieval?.topK), 6),
    candidatePool: intVal(pick(env.MASCOT_CANDIDATES, file.retrieval?.candidatePool), 24),
    contextChars: intVal(pick(env.MASCOT_CONTEXT_CHARS, file.retrieval?.contextChars), 9000),
  },

  chunking: {
    targetChars: intVal(pick(env.MASCOT_CHUNK_CHARS, file.chunking?.targetChars), 900),
    overlapChars: intVal(pick(env.MASCOT_CHUNK_OVERLAP, file.chunking?.overlapChars), 140),
    maxCharsPerApp: intVal(pick(env.MASCOT_MAX_CHUNKS, file.chunking?.maxChunksPerApp) ?? file.maxChunksPerApp, 20000),
  },

  serveExamples: boolVal(pick(env.MASCOT_SERVE_EXAMPLES, file.serveExamples), false),

  limits: {
    maxBodyBytes: intVal(pick(env.MASCOT_MAX_BODY, file.limits?.maxBodyBytes), 2_000_000),
    maxUploadChars: intVal(pick(env.MASCOT_MAX_UPLOAD_CHARS, file.limits?.maxUploadChars), 1_500_000),
    sessionsPerApp: intVal(pick(env.MASCOT_SESSIONS_PER_APP, file.limits?.sessionsPerApp), 300),
    messagesPerSession: intVal(pick(env.MASCOT_MESSAGES_PER_SESSION, file.limits?.messagesPerSession), 60),
  },
};

export const PROVIDER_PRESETS = {
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { baseUrl: 'https://api.anthropic.com', defaultModel: 'claude-3-5-haiku-latest', keyEnv: 'ANTHROPIC_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', keyEnv: 'GROQ_API_KEY' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', defaultModel: 'llama3.1', keyEnv: '' },
  'openai-compatible': { baseUrl: '', defaultModel: '', keyEnv: 'MASCOT_LLM_API_KEY' },
  mock: { baseUrl: '', defaultModel: 'mock-1', keyEnv: '' },
};

/** Resolve provider/baseUrl/model/apiKey, applying presets and env fallbacks. */
export function resolveLlmSettings(override = {}) {
  let provider = String(override.provider || config.llm.provider || 'auto').toLowerCase();
  const preset = PROVIDER_PRESETS[provider] || null;

  if (provider === 'auto') {
    if (env.ANTHROPIC_API_KEY) provider = 'anthropic';
    else if (env.OPENAI_API_KEY || env.GROQ_API_KEY || env.MASCOT_LLM_API_KEY || config.llm.apiKey || config.llm.baseUrl) provider = 'openai-compatible';
    else provider = 'none';
  }

  const merged = {
    provider,
    baseUrl: override.baseUrl || config.llm.baseUrl || preset?.baseUrl || '',
    model: override.model || config.llm.model || preset?.defaultModel || '',
    apiKey: override.apiKey || config.llm.apiKey || (preset?.keyEnv ? env[preset.keyEnv] : '') || '',
    temperature: override.temperature ?? config.llm.temperature,
    maxTokens: override.maxTokens ?? config.llm.maxTokens,
    timeoutMs: config.llm.requestTimeoutMs,
  };

  if (provider === 'openai-compatible' && merged.baseUrl && !merged.model) merged.model = 'gpt-4o-mini';
  const configured = provider === 'mock'
    || (provider === 'openai-compatible' && !!merged.baseUrl)
    || (provider === 'anthropic' && !!merged.apiKey)
    || (provider === 'openai' && !!merged.apiKey)
    || (provider === 'groq' && !!merged.apiKey)
    || (provider === 'ollama' && !!merged.baseUrl);

  return { ...merged, configured };
}

export function resolveEmbeddingsSettings(override = {}) {
  const provider = String(override.provider || config.embeddings.provider || 'none').toLowerCase();
  const merged = {
    provider,
    baseUrl: override.baseUrl || config.embeddings.baseUrl
      || (provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'),
    model: override.model || config.embeddings.model || (provider === 'ollama' ? 'nomic-embed-text' : 'text-embedding-3-small'),
    apiKey: override.apiKey || config.embeddings.apiKey || env.OPENAI_API_KEY || '',
  };
  const configured = provider !== 'none' && provider !== 'local' && (
    provider === 'ollama' ? !!merged.baseUrl : !!merged.apiKey || !!merged.baseUrl
  );
  return { ...merged, configured };
}
