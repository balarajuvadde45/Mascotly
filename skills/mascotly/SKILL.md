---
name: mascot
description: Embed an AI mascot into any application with Mascotly — create an app, ingest the host app's docs/repo, run the analyzer, and produce a one-tag embed snippet. Use when the user asks to add a mascot, chatbot, AI assistant, or embeddable agent to their application, or to set up Mascotly.
---

# Mascotly

Mascotly is an open-source embeddable AI mascot for any application. One script tag in the host
app; a self-hosted Mascotly server studies the host application (docs URLs, sitemaps, GitHub repos,
files, reviews, and shipped artifacts via REA) and answers end-user questions with citations.

## When to use this skill

- "Add a mascot/bot/assistant to my app"
- "Set up Mascotly for this project"
- "Embed an AI chat widget that knows our docs"

## Prerequisites

- Node.js ≥ 18.17 (22+ for REA).
- A Mascotly server running locally (`npm start` in the Mascotly repo, default http://localhost:4242)
  or a reachable Mascotly deployment.
- This MCP server registered (`mascot setup --client <your-client>`) — if the `mascot_*` tools are
  available, you are ready.

## Workflow

1. **Create the app** — one Mascotly app per host application:
   `mascot_create_app { name, description, docsUrl? }`. The response contains `appId` and
   `publicKey` — keep them for the embed snippet.
2. **Feed it knowledge** (more is better; 3–10 sources is a good start):
   - `mascot_add_source { appId, type: "url", url }` for docs pages
   - `mascot_add_source { appId, type: "crawl", url, maxPages: 10 }` for a docs section
   - `mascot_add_source { appId, type: "github", repo: "owner/name" }` for the repo's README + docs
   - `mascot_add_source { appId, type: "text"|"reviews", text }` for pasted docs or review dumps
   All sources run inline and return chunk counts.
3. **Analyze** — `mascot_analyze { appId }` synthesizes the app profile (purpose, features,
   limitations, FAQs) that shapes the mascot's persona and answer quality. Re-run after adding
   significant sources.
4. **Verify** — `mascot_search { appId, query }` to check retrieval, then
   `mascot_chat { appId, message }` to test a real answer end-to-end.
5. **Embed** — `mascot_embed_snippet { appId, serverUrl }` returns the exact HTML the user pastes
   into their app. Host actions can be registered with
   `window.Mascotly.registerAction(name, handler)` in the host app and declared in the dashboard.

## Optional: REA (reverse engineering)

If the host application ships artifacts (Electron bundle, ASAR, JS tree) and REA is installed
(`npm i -g rea-agents`, check with `mascot_rea_status`), run
`mascot_rea { appId, target, kind }` on the **self-hosted** mode to fold modules, entry points and
features into the mascot's knowledge. REA needs local file paths and cannot run on serverless.

## Rules

- Never invent facts about the host app — answers come strictly from indexed knowledge.
- Always run `mascot_analyze` after the first sources, or answers will be raw excerpts.
- Prefer the user's real docs URLs over scraping marketing pages.
- The `publicKey` is embeddable and safe to ship; the `secretKey` is not — never put it in client code.
- On serverless deployments (Vercel), long crawls are capped and REA is unavailable; use the
  self-hosted mode for those.

## Troubleshooting

- "No usable content found" — the page is JS-rendered; try the GitHub repo or paste text instead.
- Empty answers — run `mascot_analyze` and confirm `mascot_search` returns results.
- Rate limit — per-app setting in the dashboard (Settings → Behavior).
