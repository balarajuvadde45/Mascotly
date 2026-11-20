# Contributing

Thanks for improving Mascotly! 🤖

## Setup

```bash
npm install
npm run dev       # watch mode
npm test          # unit + integration tests (node:test)
npm run check     # syntax-check all sources
```

## Ground rules

1. **Zero-dependency philosophy** — runtime deps stay minimal (currently just `express`). Prefer
   Node built-ins; add a dependency only with a strong justification.
2. **Works offline** — every feature must degrade gracefully without an LLM/embedding provider.
   The mock brain + extractive analyzer are the baseline.
3. **Tests** — add/extend tests for behavior changes. `test/api.test.mjs` boots the real server;
   unit tests live alongside in `test/`.
4. **Docs** — update the relevant page in `docs/` and README when behavior changes.
5. **Security** — no shell string composition; escape-first rendering in UI code; timing-safe key
   comparisons; validate paths/args for anything that leaves the process.

## Areas that particularly need help

- Vector-store adapters (Qdrant/pgvector) behind the retriever interface
- More ingestors (Confluence, Notion exports, RSS, Zendesk)
- Widget i18n and RTL
- Dashboard accessibility pass

## Submitting

1. Fork / branch (`feat/my-feature`).
2. `npm test && npm run check` must pass.
3. Keep PRs focused; include a short rationale and screenshots for UI changes.
