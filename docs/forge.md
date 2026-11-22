# The Forge — repository → mascot

The Forge is Mascotly's flagship pipeline: **give it a repository and it builds you a bot**.

1. **Ingest** — the repo's README + docs trees are pulled through the GitHub
   ingestor (private repos: pass a GitHub token).
2. **Analyze** — a reasoning model studies the material: what the app is, who
   uses it, the questions its users actually ask, and the gotchas they hit
   (prompt: `FORGE_ANALYZE` in `src/prompts.js`).
3. **Design** — a second prompt acts as a product designer: mascot name, emoji,
   color, voice, greeting, starter questions, and up to 3 SKILL.md skills
   (`FORGE_SPEC`).
4. **Build** — the app is created, skills installed, extra sources fetched, and
   the analyzer generates the profile from real knowledge.
5. **Ship** — you get the embed snippet, a static **bot starter bundle**
   (index.html + vercel.json + README), and deployment guidance.

## Run it

Dashboard: **🔥 Forge from repo** → repository, intent (free text), optional
GitHub token, optional Vercel token → **Forge the mascot**.

API:

```bash
curl -X POST https://your-mascotly-host/api/forge \
  -H "x-mascot-key: $ADMIN_KEY" -H "content-type: application/json" \
  -d '{"repo": "docsifyjs/docsify", "intent": "docs assistant", "vercelToken": "…"}'
# → { jobId }  — poll GET /api/forge/jobs/:jobId (or GET /api/apps/:id/jobs/:jobId after creation)
```

MCP: `mascot_forge { repo, intent, githubToken?, vercelToken?, serverUrl? }`.

## Deployment targets

### Vercel (bot starter page)

Provide a `vercelToken` ([create one](https://vercel.com/account/tokens)) and the
Forge deploys a static bot starter page via `POST /v13/deployments` (inline
files). You get back the live URL. The widget still talks to *your* Mascotly
server — deploy that once (Vercel + KV, or Docker) and all bots share it.

### AWS (platform + starter pages)

- **Platform**: the repo's Dockerfile runs unchanged on **ECS Fargate** or
  **App Runner** behind an ALB (health check: `/api/health`). Set
  `MASCOT_DATABASE_URL` (Postgres/RDS) and `MASCOT_REDIS_URL` (ElastiCache) in
  the task definition for production state and memory.
- **Bot starter pages**: upload the static bundle to **S3 + CloudFront**.

## Requirements

- A configured LLM (any OpenAI-compatible endpoint, Anthropic, Groq, Ollama) —
  the Forge designs with a real brain.
- `GITHUB_TOKEN` env or a per-request token for higher GitHub API limits and
  private repos.
- Not available in serverless mode (the pipeline runs local ingestion + analysis
  and is bounded by function duration).
