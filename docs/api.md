# HTTP API reference

Base URL: `http://your-mascot-host`

All bodies are JSON unless noted. Errors return `{ "error": code, "message": string }` with an
appropriate HTTP status.

## Authentication

| Who | How | Can do |
| --- | --- | --- |
| Admin | header `X-Mascotly-Key: <adminKey>` (or `Authorization: Bearer`) | everything |
| App secret | header `X-Mascotly-Key: <app.secretKey>` | that app's admin surface |
| Public | path credentials `/api/v1/.../:appId/:publicKey` | widget-config, chat, feedback |

The admin key lives in `data/admin.json` (printed on first boot) or `MASCOT_ADMIN_KEY`.

## System

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | — | liveness `{ ok, version, uptimeSec }` |
| GET | `/api/system` | admin | providers (LLM/REA), runtime + storage mode, node version |

## Apps

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/apps` | admin | create app `{ name*, description, mascot{}, settings{}, docsUrl? }` → full app incl. keys |
| GET | `/api/apps` | admin | list (keys masked) + knowledge stats |
| GET | `/api/apps/:appId` | admin/secret | full app + knowledge stats |
| PATCH | `/api/apps/:appId` | admin/secret | update `name, description, mascot{}, settings{}` |
| DELETE | `/api/apps/:appId` | admin/secret | delete app + all data |
| POST | `/api/apps/:appId/keys/rotate` | admin/secret | regenerate both keys |

Mascotly fields: `name, emoji, color, greeting, tagline, personality, welcome, suggestions[],
actions[{name, description, argsHint}], position`.
Settings fields: `rateLimitPerMin, allowedOrigins[], escalationKeywords[], autoAnalyze,
systemPromptExtra, model{provider,baseUrl,model,apiKey}, embeddings{provider,model,apiKey,baseUrl}`.

## Knowledge sources

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/apps/:appId/sources` | admin/secret | list + knowledge stats |
| POST | `/api/apps/:appId/sources` | admin/secret | add a source (below) |
| POST | `/api/apps/:appId/sources/:sid/reingest` | admin/secret | re-fetch/re-index |
| DELETE | `/api/apps/:appId/sources/:sid` | admin/secret | remove source + chunks |
| POST | `/api/apps/:appId/search` | admin/secret | retrieval preview `{ query, k? }` |

Source payloads by `type`:

```json
{ "type": "text",    "label": "FAQ", "text": "…" }
{ "type": "reviews", "label": "App store reviews", "text": "one review per line…" }
{ "type": "file",    "label": "docs.md", "content": "…", "encoding": "text|base64" }
{ "type": "url",     "url": "https://app.com/docs/page", "label": "optional" }
{ "type": "crawl",   "url": "https://app.com/docs", "maxPages": 10, "sameOrigin": true }
{ "type": "sitemap", "url": "https://app.com/sitemap.xml", "maxUrls": 20 }
{ "type": "github",  "repo": "owner/name", "branch": "main" }
```

`text`, `file`, `reviews` respond synchronously (`201 { chunkCount, docCount, charCount }`); URL-based
types respond `202 { sourceId, jobId }` — poll the job. In **serverless mode** (Vercel) all types run
inline and return `200 { ok, sourceId, chunkCount, …, inline: true }` directly.

## Analysis

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/apps/:appId/profile` | admin/secret | current app profile |
| POST | `/api/apps/:appId/analyze` | admin/secret | start analysis → `202 { jobId }` (server) or `200 { inline: true, result }` (serverless) |
| GET | `/api/apps/:appId/jobs/:jobId` | admin/secret | job status/progress/steps |

## Capabilities (skills / tools / hooks)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/apps/:appId/skills` | admin/secret | list installed SKILL.md packs |
| POST | `/api/apps/:appId/skills` | admin/secret | install `{ content }` (raw SKILL.md; frontmatter name/description parsed) |
| PATCH | `/api/apps/:appId/skills/:skillId` | admin/secret | toggle `{ enabled }` |
| DELETE | `/api/apps/:appId/skills/:skillId` | admin/secret | remove |
| GET/POST | `/api/apps/:appId/tools` | admin/secret | list / register tool plugins `{ name, description, url, method, headers? }` |
| PATCH | `/api/apps/:appId/tools/:toolId` | admin/secret | toggle `{ enabled }` |
| DELETE | `/api/apps/:appId/tools/:toolId` | admin/secret | remove |
| GET/POST | `/api/apps/:appId/hooks` | admin/secret | list / register webhooks `{ event: message|escalation|feedback, url, secret? }` |
| POST | `/api/apps/:appId/hooks/:hookId/test` | admin/secret | fire a test delivery |
| DELETE | `/api/apps/:appId/hooks/:hookId` | admin/secret | remove |
| GET | `/api/apps/:appId/plugin-manifest` | admin/secret | export skills+tools as `mascotly-plugin/1` |
| POST | `/api/apps/:appId/plugin-manifest` | admin/secret | import a manifest into this app |

Hook deliveries are POSTed with `x-mascot-event` and `x-mascot-signature: sha256=HMAC(secret, body)`.
The mascot calls tool plugins mid-chat via its JSON tool protocol; responses are fed back for the final answer.

## REA

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/apps/:appId/rea/status` | admin/secret | detected mode/command/version |
| POST | `/api/apps/:appId/rea` | admin/secret | `{ target, kind: 'javascript'|'asar'|'custom', command?, args? }` → `202 { jobId }` |

## Sessions

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/apps/:appId/sessions` | admin/secret | list (previews, escalation flags) |
| GET | `/api/apps/:appId/sessions/:sessionId` | admin/secret | full transcript |
| DELETE | `/api/apps/:appId/sessions/:sessionId` | admin/secret | delete |

## Public widget API

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/v1/widget-config/:appId/:publicKey` | public | mascot identity + suggestions (cacheable) |
| POST | `/api/v1/chat/:appId/:publicKey` | public + rate limit | `{ message, sessionId?, history?, page? }` → `{ answer, citations[], action?, escalated, sessionId, usage }` |
| POST | `/api/v1/stream/:appId/:publicKey` | public + rate limit | same input; SSE response |
| POST | `/api/v1/feedback/:appId/:publicKey` | public | `{ sessionId, rating: 'up'|'down', comment? }` |

SSE events: `meta` → (`status` | `delta` | `action`)* → `done` (`| error`).

```
event: delta
data: {"text":"partial answer…"}

event: action
data: {"name":"navigate","args":{"url":"…"}}

event: done
data: {"answer":"…","citations":[{"n":1,"label":"…","url":"…"}],"escalated":false,"sessionId":"ses_…","usage":{…}}
```

## Static

| Path | Description |
| --- | --- |
| `/` | landing page |
| `/dashboard/` | admin SPA |
| `/widget/mascot-widget.js` | embeddable widget SDK |
| `/examples/*` | static extras (disable with `MASCOT_SERVE_EXAMPLES=false`; not deployed on serverless) |

## Rate limiting

Chat endpoints use a per-app sliding window (default 20 msgs/min per visitor IP, keyed by
`x-forwarded-for` when present). Exceeding it returns `429` with a `retry-after` header.
