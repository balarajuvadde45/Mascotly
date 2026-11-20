# Architecture

Mascotly is a single Node.js process with no database dependency. Everything is file-backed JSON with
atomic, debounced writes.

## Components

```
src/
  index.js               entry: config, store, HTTP server, graceful shutdown
  config.js              env + mascot.config.json resolution, provider presets
  server.js              express app factory: middleware, static, routes, error handling
  store.js               file-backed storage engine (atomic writes, debounced flush)
  jobs.js                in-memory job tracker + persisted summaries per app
  providers/
    llm.js               LLM abstraction: openai-compatible, anthropic, groq, ollama, mock
    embeddings.js        embedding providers: openai-compatible, ollama, none(local)
  knowledge/
    crawler.js           polite fetch (robots.txt), HTML→markdown-lite, links, sitemap, GitHub
    chunker.js           heading-aware chunking, sentence splitting with overlap, review grouping
    tokenize.js          tokenizer + stopwords
    retriever.js         BM25 + dense/sparse cosine + RRF fusion, snippet extraction
    service.js           per-app retriever cache, query embedding, knowledge stats
    ingest.js            source orchestration: text/file/url/crawl/sitemap/github/reviews → chunks
  brain/
    prompt.js            persona + knowledge + rules → system prompt
    agent-protocol.js    model-facing JSON protocol parsing (tool requests, host actions)
    agent.js             chatStream pipeline: retrieve → stream LLM → optional tool round → done
  analysis/
    analyzer.js          app-profile synthesis (LLM map-reduce or extractive heuristic)
  rea/
    adapter.js           rea CLI detection + validated spawn (rea | npx rea-agents), output caps
    parser.js            tolerant Evidence-record parsing → sections + insights → docs
  store-upstash.js       Upstash/Vercel-KV REST adapter (serverless mode)
  store-factory.js       picks file store (default) or KV adapter (Vercel)
  routes/
    middleware.js        auth (admin/secret/public), rate limiting, SSE helpers, CORS, errors
    apps.js              admin API: apps, sources, analysis, jobs, search, REA, sessions
                         (detached jobs on servers; inline on serverless)
    chat.js              public API: widget-config, chat (JSON + SSE), feedback
```

## Data model

```
<dataDir>/
  admin.json                       { key }                        admin master key
  registry.json                    { apps: [{id, slug, name}] }   app index
  apps/<appId>/
    app.json                       full app record
    sources.json                   knowledge sources
    chunks.json                    indexed knowledge chunks
    profile.json                   analyzer output (app understanding)
    sessions/<sessionId>.json      chat transcripts
```

App record (abridged):

```json
{
  "id": "app_…",
  "name": "My App",
  "publicKey": "…32 hex…",
  "secretKey": "…48 hex…",
  "mascot": { "name", "emoji", "color", "greeting", "tagline", "personality",
              "welcome", "suggestions", "actions", "position" },
  "settings": { "rateLimitPerMin", "allowedOrigins", "escalationKeywords",
                "autoAnalyze", "systemPromptExtra", "model?", "embeddings?" },
  "stats": { "messages", "sessions", "chunks", "ingestedChars", "lastChatAt", "lastAnalyzedAt" },
  "jobs": [ /* last 8 job summaries (upserted) */ ]
}
```

Chunk:

```json
{ "id": "ch_…", "appId": "…", "sourceId": "src_…", "ord": 0,
  "text": "[Section › Subsection]\n…", "heading": "Subsection",
  "headingPath": "Section › Subsection",
  "meta": { "label", "title", "url", "kind", "sourceType" },
  "embedding": null | [floats],
  "createdAt": "…" }
```

## Chat pipeline (`chatStream`)

```
message ──► sanitize + rate-limit (route) ──► retrieve top-K (BM25 ⊕ vectors, RRF)
        ──► build system prompt (persona + profile + knowledge blocks + rules + protocol)
        ──► stream LLM round 1 (hold-back window hides protocol JSON from the user)
        ──► parse protocol:
              ├─ {"mascot_tool":{"name":"search_knowledge"}} → extra retrieval → append context
              │   → stream round 2 (max 2 extra rounds)
              └─ {"mascot_action":{"name":…}} → validate against allowed actions → emit event
        ──► escalation heuristics (keywords)
        ──► done event { answer, citations, action, escalated, usage }
        ──► route persists session transcript, updates stats
```

No LLM configured? An extractive fallback composes the answer from the top knowledge chunks with
citations and a note, streamed like any other answer. `provider: mock` gives deterministic templated
answers (tests / zero-config demos).

## Retrieval

- **BM25** (k1=1.5, b=0.75) over tokenized chunks (headings included via breadcrumb prefix).
- **Vector ranking** — dense embeddings when a provider is configured, otherwise sparse TF-IDF
  vectors computed locally at index time (no network, deterministic).
- **Fusion** — reciprocal rank fusion (`1/(60+rank)`), dedup, top-K.
- Citations carry source label, URL, heading, and a query-centered snippet.

## Ingestion flow

```
source record (pending) → type-specific fetcher (async job w/ progress)
  → markdown-lite text → heading-aware chunks (+ meta: label/title/url/kind)
  → optional embedding → replace chunks for that sourceId → source (ready, stats)
  → auto-analyze (first source only, if settings.autoAnalyze)
```

Caps: `maxCharsPerPage` (crawler), `maxUploadChars` (uploads), `maxChunksPerApp` (knowledge limit),
per-type page/file caps. Robots.txt is honored with Allow/Disallow longest-match.

## Analyzer

Two engines, same output shape (`profile.json`):

1. **LLM map-reduce** — chunks batched (~6k chars), per-batch JSON extraction, final reduce prompt
   → validated profile + starter questions. `confidence: 'llm'`.
2. **Extractive heuristic** — headings → features, FAQ Q/A patterns, limitation cues, bullet
   capabilities, summary from the first chunks + app description. Always available.

REA insights (from previous REA runs) are folded into every new profile.

## Concurrency & persistence

- All writes are **atomic** (tmp + rename) and **debounced** (200–400 ms); `flushAll()` drains on
  SIGINT/SIGTERM.
- Job progress lives in memory; the last 8 summaries per app persist in `app.json`.
- Retrievers are cached per app and rebuilt automatically when the chunk array changes.

## Security model

See [security.md](security.md). Short version: admin key for management, per-app secret key for app
administration, per-app public key (embeddable, origin-allowlist aware) for chat, per-IP sliding-window
rate limits, strict output escaping in the widget, array-spawned subprocess calls with argument
validation for REA.
