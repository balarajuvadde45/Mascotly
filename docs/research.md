# Research Notes (design inputs)

Captured during the initial research pass that informed Mascotly's architecture.

## 1. REA — Reverse Engineer Anything (`github.com/morluto/rea`)

- **What it is:** an MCP server + CLI (`rea-agents` npm package) that lets AI agents inspect
  native binaries, Electron apps, ASAR archives, JavaScript bundles, .NET assemblies, Android
  APKs, firmware, packet captures and more — locally, without source code. MIT licensed.
- **Install:** `npm install --global rea-agents` (or use on-demand via `npx -y rea-agents@latest ...`).
  Runtime: Node.js 22.x / 24.x / 26+. Static JS/.NET analysis needs no native engine.
- **Key CLI fallback used by Mascotly's adapter:**
  `npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json`
  Returns an Evidence record (JSON) describing modules, imports, boundaries and their evidence.
- **Mascotly integration decision:** shell out to REA with array-spawned args (never a shell string),
  cap output size, parse defensively (JSON first, structured section fallback), convert findings into
  knowledge chunks + structured `insights`, and degrade gracefully when REA is not installed.

## 2. Embeddable widget best practice

- Consensus across practitioner write-ups: build the widget as a **framework-agnostic Web Component**
  (custom element + Shadow DOM) loaded by a single `<script>` tag, so it works identically in React,
  Vue, Angular, Svelte and plain HTML, with CSS isolation via Shadow DOM.
- Core layers: UI layer, state/session layer, streaming/API layer, messaging layer.
- Avoid global namespace pollution; expose one init entry point (`window.Mascotly`) + events.

## 3. RAG pipeline best practice

- **Hybrid retrieval**: never rely on vectors alone — combine lexical (BM25) with vector similarity
  and fuse rankings (reciprocal rank fusion). Mascotly implements BM25 always, plus TF-IDF cosine
  locally and remote embeddings (OpenAI-compatible / Ollama) when configured, fused with RRF.
- **Chunking**: semantic/heading-aware chunking beats fixed-size; align chunk size with the model
  context window; preserve sentence boundaries; keep a small overlap.
- **Metadata enrichment**: store heading path, source label, URL on every chunk to improve retrieval
  and citation quality.

## 4. Competitive landscape

- **Botpress** — visual flow builder + LLM (MIT, self-hostable).
- **Typebot** — drag-and-drop conversation flows, very portable embeds.
- **Chatwoot** — self-hosted live-support platform with an Agent Bot API.
- **Gap none of them fill:** *automatic self-bootstrapping* — a bot that reads the host application's
  docs, reviews, repository and (via REA) shipped artifacts, then builds its own knowledge and
  persona. Mascotly's identity is exactly that: **"drop in one script tag; the AI studies your app."**

## Sources

- REA repository: https://github.com/morluto/rea
- REA local skill documentation (reverse-engineer-anything skill, CLI fallback section)
- How I Built an Embeddable AI Chat Toolkit — https://medium.com/@sudheeshshetty/how-i-built-an-embeddable-ai-chat-toolkit-and-open-sourced-it-ef4b9f7874fd
- Seeking Modern Methods to Embed Chatbots in Multiple Sites — https://www.reddit.com/r/reactjs/comments/18xnml1/seeking_modern_methods_to_embed_chatbots_in
- RAG Pipeline Best Practices — https://medium.com/@visrow/rag-pipeline-best-practices-10-critical-engineering-decisions-for-production-systems-937a6f8d141c
- Chunking Strategies and Hybrid RAG — https://jamwithai.substack.com/p/chunking-strategies-and-hybrid-rag
- Chunking Strategies for RAG — https://atlan.com/know/chunking-strategies-rag
- ChatterMate vs Chatwoot vs Typebot — https://dev.to/chattermate/chattermate-vs-chatwoot-vs-typebot-which-open-source-chat-platform-is-right-for-you-ba9
- Botpress vs Typebot — https://faun.dev/toolbox/botpress-vs-typebot
- Botpress open-source chatbot roundup — https://botpress.com/blog/open-source-chatbots
