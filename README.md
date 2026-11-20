<div align="center">

# 🤖 Mascotly

**The open-source AI mascot that lives inside any application.**

Drop in one script tag. Mascotly studies your app — from its docs, reviews and repos, and
even from its shipped artifacts via [REA](https://github.com/morluto/rea) — then answers
your users' questions with citations, in your app's voice.

`Node.js ≥ 18` · `MIT` · `zero native deps` · `works offline`

</div>

---

## Why Mascotly?

Every existing bot framework gives you *tools* to build a bot. **Mascotly builds the brain for you:**

1. **Feed it your app** — a docs URL, a sitemap, a GitHub repo, uploaded files, pasted text, review dumps.
2. **The analyzer studies it** — it synthesizes an app profile (purpose, features, limitations, FAQs, tone)
   that becomes the mascot's identity.
3. **Embed one script tag** — a dependency-free Web Component appears in any React / Vue / Angular /
   Svelte / Electron / plain-HTML app, fully style-isolated via Shadow DOM.
4. **It answers with citations** — hybrid BM25 + TF-IDF-vector retrieval (offline by default), streaming
   responses, host-action triggers, human escalation.

Optionally point it at your **shipped Electron bundle / ASAR archive / JS tree** and the
[REA CLI](https://github.com/morluto/rea) (`rea-agents`) reverse-engineers modules, entry points and
features — folded straight into the mascot's knowledge.

## Quickstart

```bash
npm install
npm start            # → http://localhost:4242
```

Open **http://localhost:4242/dashboard/**, create a mascot, give it a docs URL, click **Run analyzer**,
then paste the embed snippet into any page:

```html
<script src="http://localhost:4242/widget/mascot-widget.js"></script>
<script>
  window.Mascotly.init({
    server: 'http://localhost:4242',
    appId: 'app_xxxxxxxxxxxx',        // from the dashboard
    publicKey: 'pk_xxxxxxxxxxxxxxxx'  // from the dashboard
  });

  // optional: let the mascot drive your app
  window.Mascotly.registerAction('navigate', (args) => { location.href = args.url; });
</script>
```

## Deploy on Vercel

The repo deploys to Vercel with zero configuration (`vercel.json` included):

1. Push to GitHub → **Import project** in Vercel.
2. Add a **Vercel KV** store (Marketplace → KV) — Mascotly auto-detects it as its persistent store.
3. Optional env: `MASCOT_ADMIN_KEY`, `MASCOT_LLM_API_KEY`, `GITHUB_TOKEN`.
4. Deploy — landing page, dashboard, widget CDN and API go live.

Serverless mode runs ingestion and analysis inline; long crawls and REA belong on the
self-hosted/Docker mode. Details: [docs/self-hosting.md](docs/self-hosting.md#vercel-serverless).

## Install through your agent

Mascotly ships an **MCP server** and an agent skill. Claude Code, Codex CLI, Cursor, Windsurf,
Gemini CLI and VS Code can set everything up for you:

```bash
node bin/mascot.js setup --client claude_code --install-skill
# also: codex · cursor · windsurf · gemini_cli · claude_desktop · vscode · all
```

Then ask your agent: *"Add a mascot to my app — docs at https://myapp.com/docs, repo myorg/myapp.
Verify it answers 'how do I deploy?' and give me the embed snippet."* The agent gets tools like
`mascot_create_app`, `mascot_add_source`, `mascot_analyze`, `mascot_chat` and
`mascot_embed_snippet`. Full guide: [docs/agents.md](docs/agents.md).

### Connect a real brain (any LLM)

```bash
# OpenAI-compatible (OpenAI, Groq, Together, vLLM, LM Studio, …)
export MASCOT_LLM_PROVIDER=openai-compatible
export MASCOT_LLM_BASE_URL=https://api.openai.com/v1
export MASCOT_LLM_API_KEY=sk-...
export MASCOT_LLM_MODEL=gpt-4o-mini

# …or Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# …or local Ollama
export MASCOT_LLM_PROVIDER=ollama
# (default base URL http://127.0.0.1:11434/v1, model llama3.1)

npm start
```

No keys? Mascotly ships with a **deterministic offline brain** (extractive answers with citations)
so everything works — tests, demos, development — with zero configuration. Per-app model overrides
are available in the dashboard.

## Architecture

```
┌─────────────────────────────  your app  ─────────────────────────────┐
│   <script src="…/widget/mascot-widget.js">                           │
│   ┌───────────────────────────────┐      ┌────────────────────────┐  │
│   │  Mascotly widget (Web Component)│      │  host actions          │  │
│   │  Shadow DOM · SSE streaming   │◄─────│  Mascotly.registerAction │  │
│   └──────────────┬────────────────┘      └────────────────────────┘  │
└──────────────────┼───────────────────────────────────────────────────┘
                   │ /api/v1/chat | /api/v1/stream (SSE)
                   ▼
┌──────────────────────────  Mascotly server  ───────────────────────────┐
│  brain        chatStream: retrieve → LLM → (tool round) → answer     │
│  retrieval    BM25 ⊕ TF-IDF cosine / remote embeddings (RRF fusion)  │
│  knowledge    ingest: URLs · crawls · sitemaps · GitHub · files ·    │
│               reviews · REA findings → heading-aware chunks         │
│  analyzer     LLM map-reduce (or extractive) → app profile          │
│  providers    OpenAI-compatible · Anthropic · Groq · Ollama · mock  │
│  storage      atomic JSON files (data/) — no database needed        │
│  dashboard    admin SPA: apps · identity · knowledge · REA · chat · │
│               sessions · settings                                   │
└──────────────────────────────────────────────────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for the full design.

## Features

| Area | What you get |
| --- | --- |
| **Widget** | One-tag embed, Shadow DOM isolation, SSE streaming with typing/status indicators, markdown-lite rendering, citation chips, starter suggestions, proactive teaser, mobile bottom-sheet, events + actions API, session persistence |
| **Knowledge** | Docs URL fetch, robots-aware multi-page crawl, sitemap ingestion, GitHub repo docs, file upload (md/txt/html/csv/json), pasted text, review dumps, REA analysis output |
| **Analyzer** | LLM map-reduce profile synthesis; offline extractive fallback; features / audience / limitations / FAQs / tone / starter questions |
| **Retrieval** | BM25 always; sparse TF-IDF cosine vectors locally; remote embeddings (OpenAI-compatible / Ollama) optional; reciprocal-rank-fusion hybrid |
| **Brain** | Retrieval-augmented chat, one agentic knowledge-search round, host-action JSON protocol, escalation keywords, per-app model overrides |
| **Admin** | Dashboard SPA (overview, identity editor, knowledge manager, retrieval tester, REA runner, live test chat, session transcripts, settings), jobs with live progress |
| **Ops** | File-backed storage with atomic writes, rate limiting, origin allowlists, key rotation, Dockerfile, ~2 MB RSS baseline, no database |

## Era capabilities: skills, hooks, tool plugins

Built for the current agent ecosystem (MCP at the Linux Foundation, A2A, the SKILL.md open standard):

- **Skills** — paste a [SKILL.md](https://agentskills.io) pack into an app; the mascot applies it when relevant.
- **Tool plugins** — register HTTP endpoints; the mascot calls them mid-chat (function calling) and answers from the result.
- **Hooks** — HMAC-signed webhooks on `message` / `escalation` / `feedback`.
- **Plugin manifests** — export/import skills + tools between apps.
- **MCP server + agent skill** — Claude Code, Codex, Cursor, Windsurf, Gemini CLI and VS Code manage everything for you.

See [docs/capabilities-research.md](docs/capabilities-research.md) for the research behind these choices.

## REA integration

[REA — Reverse Engineer Anything](https://github.com/morluto/rea) (`rea-agents`) inspects shipped
artifacts without source code. Mascotly shells out to it with strictly validated, array-spawned
arguments, size-caps the output, parses the Evidence record defensively, and converts findings into
knowledge chunks + structured insights (modules, stack, entry points, features).

```bash
npm install --global rea-agents     # or: let Mascotly use `npx -y rea-agents@latest`
```

Then in the dashboard: **your app → REA → target path → Run**. Details: [docs/rea.md](docs/rea.md).

## API

Full reference in [docs/api.md](docs/api.md). Highlights:

```bash
# admin
POST   /api/apps                       # create app (+optional docsUrl)
POST   /api/apps/:id/sources           # { type: 'url'|'crawl'|'sitemap'|'github'|'text'|'file'|'reviews', … }
POST   /api/apps/:id/analyze           # run the analyzer
POST   /api/apps/:id/rea               # { target, kind: 'javascript'|'asar' }
POST   /api/apps/:id/search            # retrieval preview

# public (widget)
GET    /api/v1/widget-config/:appId/:publicKey
POST   /api/v1/chat/:appId/:publicKey          # JSON
POST   /api/v1/stream/:appId/:publicKey        # SSE
```

Auth: admin key (`X-Mascotly-Key`), per-app secret key, per-app public key + optional origin allowlist.

## Configuration

Everything is env-driven (or `mascot.config.json`) — see [docs/self-hosting.md](docs/self-hosting.md):
`MASCOT_PORT`, `MASCOT_DATA_DIR`, `MASCOT_ADMIN_KEY`, `MASCOT_LLM_*`, `MASCOT_EMBEDDINGS_*`,
`MASCOT_REA_*`, `MASCOT_CRAWL_*`, `MASCOT_TOP_K`, `MASCOT_MAX_CHUNKS`, …

Docker:

```bash
docker compose up    # serves on :4242 with a mounted data volume
```

## Project layout

```
src/            server, brain, knowledge, analyzer, REA adapter, routes, storage adapters
api/            serverless entry point (Vercel)
public/         landing page, dashboard SPA, widget SDK
mcp/            MCP server for harness agents (Claude Code, Codex, Cursor, …)
skills/         agent skill (installed by `mascot setup --install-skill`)
bin/            CLI: serve · create-app · list · setup
integrations/   real-world integration with docsify (github.com/docsifyjs/docsify)
test/           unit + integration + MCP + KV-store tests (node:test)
docs/           architecture, integration, API, REA, agents, security, self-hosting
```

## Development

```bash
npm test         # 41 tests: unit, end-to-end server flow, MCP server, KV store
npm run check    # syntax-check every source file
npm run dev      # watch mode
node integrations/docsify/seed.mjs   # seed the real OSS integration
```

## Roadmap

- [ ] Optional SQLite/pg vector store adapters
- [ ] Multi-language docs crawling + auto-translate
- [ ] Human handoff inbox with live replies
- [ ] Voice input / TTS personas
- [ ] Analytics dashboard (funnels, unanswered questions report)
- [ ] Widget theming API + custom avatars

## Community

- Contributing guide: [CONTRIBUTING.md](CONTRIBUTING.md)
- Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- Security policy: [SECURITY.md](SECURITY.md)
- Good first issues are labeled `good first issue` — start there if you're new.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Please run `npm test` and `npm run check` before submitting.

## License

MIT — see [LICENSE](LICENSE). REA is a separate project by [morluto](https://github.com/morluto/rea), also MIT.
