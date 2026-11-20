# Self-hosting

Mascotly runs in two modes from one codebase:

| Mode | Storage | Background jobs | REA | Best for |
| --- | --- | --- | --- | --- |
| **Server** (default) | atomic JSON files in `data/` | detached jobs with progress | ✅ full | local dev, Docker, VPS, any Node host |
| **Serverless** (auto on Vercel) | Upstash / Vercel KV via REST | inline within the request | ❌ (CLI-based) | Vercel / edge-ish deployments |

Set `MASCOT_STORE=file` / `MASCOT_STORE=upstash` explicitly, or let Mascotly auto-detect (`VERCEL`
env → upstash). The rest of this page covers the server mode; [Vercel](#vercel) is below.

## Requirements

- Node.js **≥ 18.17** (Node 22+ recommended; required for REA)
- ~60 MB disk + your data (JSON files grow with knowledge; budget a few MB per app)
- Outbound network access for crawls/GitHub/LLM APIs (optional — works fully offline)

## Run

```bash
npm install
npm start          # node src/index.js
```

The server listens on `0.0.0.0:4242` by default. On first boot it generates an admin key into
`data/admin.json` and prints it.

## Configuration

Environment variables (or `mascot.config.json` at the repo root — see
`mascot.config.example.json`):

### Core

| Variable | Default | Description |
| --- | --- | --- |
| `MASCOT_PORT` / `PORT` | `4242` | HTTP port |
| `MASCOT_HOST` | `0.0.0.0` | bind address |
| `MASCOT_DATA_DIR` | `./data` | storage directory |
| `MASCOT_ADMIN_KEY` | generated | fixed admin key (recommended in production) |
| `MASCOT_CONFIG` | — | path to an alternate config file |
| `MASCOT_SERVE_EXAMPLES` | `true` | serve `/examples` |

### LLM brain

| Variable | Default | Description |
| --- | --- | --- |
| `MASCOT_LLM_PROVIDER` | `auto` | `auto · openai · openai-compatible · anthropic · groq · ollama · mock · none` |
| `MASCOT_LLM_BASE_URL` | per provider | e.g. `https://api.openai.com/v1` |
| `MASCOT_LLM_API_KEY` | — | API key (also `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY` are picked up) |
| `MASCOT_LLM_MODEL` | per provider | model id |
| `MASCOT_LLM_TEMPERATURE` | `0.4` | sampling temperature |
| `MASCOT_LLM_MAX_TOKENS` | `1200` | max completion tokens |
| `MASCOT_LLM_TIMEOUT` | `60000` | request timeout (ms) |

Per-app overrides live in the dashboard (Settings → Model override) and win over the server default.

### Embeddings (optional)

| Variable | Default | Description |
| --- | --- | --- |
| `MASCOT_EMBEDDINGS_PROVIDER` | `none` | `none` (local TF-IDF) · `openai` · `openai-compatible` · `ollama` |
| `MASCOT_EMBEDDINGS_BASE_URL` | per provider | |
| `MASCOT_EMBEDDINGS_MODEL` | `text-embedding-3-small` / `nomic-embed-text` | |
| `MASCOT_EMBEDDINGS_API_KEY` | — | falls back to `OPENAI_API_KEY` |

Changing providers requires re-ingesting sources to add vectors (the hybrid BM25 keeps working
regardless).

### Retrieval / chunking / limits

| Variable | Default | Description |
| --- | --- | --- |
| `MASCOT_TOP_K` | `6` | knowledge blocks per question |
| `MASCOT_CONTEXT_CHARS` | `9000` | prompt context budget |
| `MASCOT_CHUNK_CHARS` | `900` | target chunk size |
| `MASCOT_CHUNK_OVERLAP` | `140` | sentence-split overlap |
| `MASCOT_MAX_CHUNKS` | `20000` | per-app knowledge cap |
| `MASCOT_CRAWL_MAX_PAGES` | `15` | crawl page cap (max 50 per request) |
| `MASCOT_CRAWL_TIMEOUT` | `20000` | per-page fetch timeout |
| `MASCOT_MAX_BODY` | `4000000` | request body cap (bytes) |
| `MASCOT_MAX_UPLOAD_CHARS` | `1500000` | upload text cap |
| `MASCOT_SESSIONS_PER_APP` | `300` | stored transcripts per app |
| `MASCOT_MAX_HISTORY` | `16` | chat history turns sent to the LLM |

### REA

See [rea.md](rea.md) (`MASCOT_REA_COMMAND`, `MASCOT_REA_TIMEOUT`, `MASCOT_REA_MAX_OUTPUT`).

## Vercel (serverless)

The repository is Vercel-ready — no build config needed beyond what's committed:

1. **Push to GitHub and import** the repo in Vercel. `vercel.json` (rewrites `/api/*` → the
   function at `api/index.js`, static assets from `public/`, function duration 60s) is picked up
   automatically. Mascotly detects `VERCEL` and switches to serverless mode.
2. **Add a KV store** — Vercel Marketplace → *KV* (Upstash-backed). Mascotly reads
   `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) and uses it as its
   persistent store. Without KV, app data would not survive between invocations.
3. **Environment variables** (Project → Settings → Environment Variables):
   - `MASCOT_ADMIN_KEY` — fix the admin key (otherwise generated per cold start).
   - `MASCOT_LLM_API_KEY` / `MASCOT_LLM_BASE_URL` / `MASCOT_LLM_MODEL` (or `ANTHROPIC_API_KEY`) —
     real brain; without it the offline fallback answers.
   - `GITHUB_TOKEN` — higher GitHub API limits for repo ingestion.
   - `MASCOT_KV_PREFIX` — optional, defaults to `mascot:` (one KV can host multiple deployments).
4. **Deploy.** The landing page, dashboard and widget CDN (`/widget/mascot-widget.js`) are served
   statically; the API runs as a Node function with SSE streaming enabled.

Serverless-mode behavior (automatic):

- Source ingestion and analysis run **inline** and return results directly (no 202/job polling);
  the dashboard handles both response shapes.
- Crawls and sitemap fetches carry a wall-clock budget (~45s) and stop early to stay inside the
  function duration; increase `maxDuration` in `vercel.json` (Pro plans) for bigger corpora.
- REA is unavailable (it shells out to a local CLI) — use the server/Docker mode for that.
- The in-memory rate limiter resets per cold start; for strict global limits put a proxy limit in
  front or use the self-hosted mode.

**Multi-instance consistency:** the KV adapter loads state once per cold start and writes whole
per-app blobs. Concurrent serverless instances can therefore race (last writer wins per app blob),
and a warm instance won't see apps created by another instance until it recycles. For the typical
workflow (one admin/dashboard user + widget chat traffic) this is fine; for heavy concurrent admin
usage prefer the self-hosted mode or a deployment that pins a single instance.

## Docker

```bash
docker compose up            # http://localhost:4242, data volume ./data
docker compose up -d         # detached
```

`docker-compose.yml` mounts `./data` so knowledge survives rebuilds. Build a standalone image with
`docker build -t mascot .`.

## Reverse proxy

Terminating TLS with nginx/Caddy is recommended for internet-facing deployments:

```nginx
location / {
  proxy_pass http://127.0.0.1:4242;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_http_version 1.1;
  proxy_buffering off;          # SSE streaming
  proxy_read_timeout 300s;
}
```

(`proxy_buffering off` matters for streaming; trust proxy is enabled server-side.)

## Backups

Copy the `data/` directory — it is the whole state. JSON files are written atomically, so copying
while running is safe-ish; stop the server for a guaranteed-consistent snapshot.

## Upgrading

`git pull && npm install && npm start` — data format is file-per-collection JSON; upgrades that
change schema ship with a migration note in the changelog.

## CLI

```bash
npx mascot serve                       # same as npm start
node bin/mascot.js create-app --name "My App" --docs-url https://app.com/docs
node bin/mascot.js list
```

`create-app` prints the keys and a ready-to-paste embed snippet.
