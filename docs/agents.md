# Using Mascotly through harness agents

Mascotly ships an **MCP server** and an **agent skill**, so AI coding agents — Claude Code, Codex
CLI, Cursor, Windsurf, Gemini CLI, VS Code Copilot agent mode, or any MCP-capable client — can set
up, feed, verify and embed a mascot end-to-end without touching a dashboard.

## What the agent gets

| Tool | What it does |
| --- | --- |
| `mascot_list_apps` | list configured apps + knowledge stats |
| `mascot_create_app` | create an app (optionally ingest a docs URL immediately) |
| `mascot_add_source` | ingest text / URL / crawl / sitemap / GitHub / file / reviews |
| `mascot_analyze` | run the analyzer → app profile |
| `mascot_get_profile` | read the current profile |
| `mascot_search` | run the same hybrid retrieval the mascot uses |
| `mascot_chat` | ask the mascot a question as an end user would |
| `mascot_embed_snippet` | generate the ready-to-paste embed HTML |
| `mascot_rea_status` / `mascot_rea` | REA availability + reverse-engineer a local artifact |
| `mascot_delete_app` | delete an app (requires `confirm: true`) |

All tools run against the local Mascotly store directly — no HTTP server required for the agent
workflow (the HTTP server is only needed to serve the widget/dashboard).

## One-command setup

```bash
git clone https://github.com/morluto/mascot && cd mascot
npm install

# register with your agent (creates a .mascot-backup of its config first)
node bin/mascot.js setup --client claude_code --install-skill
```

| `--client` value | Agent | Config file touched |
| --- | --- | --- |
| `claude_code` | Claude Code | `~/.claude.json` (skill → `~/.claude/skills/mascotly/`) |
| `codex` | Codex CLI | `~/.codex/config.toml` (`[mcp_servers.mascot]`) |
| `cursor` | Cursor | `~/.cursor/mcp.json` |
| `windsurf` | Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| `gemini_cli` | Gemini CLI | `~/.gemini/settings.json` |
| `claude_desktop` | Claude Desktop | platform config (macOS/Windows) |
| `vscode` | VS Code (workspace) | `.vscode/mcp.json` in the current directory |
| `all` | every client above | — |
| `generic` | prints manual MCP JSON | — |

Options: `--dry-run` (preview, write nothing), `--install-skill` (install the
[skills/mascotly/SKILL.md](../skills/mascotly/SKILL.md) agent skill where supported).

Behavior: idempotent merges (only the `mascot` entry is touched), `.mascot-backup` created before
the first write, and re-running is a no-op when already registered.

## Manual registration (any MCP client)

```json
{
  "mcpServers": {
    "mascot": {
      "command": "node",
      "args": ["/absolute/path/to/mascot/mcp/server.js"]
    }
  }
}
```

The server speaks newline-delimited JSON-RPC 2.0 over stdio (`initialize`, `tools/list`,
`tools/call`), zero dependencies.

## What to ask your agent

Once registered, a single instruction does the whole job:

> *"Add a mascot to my app at ~/projects/myapp. Its docs live at https://myapp.com/docs and the
> repo is myorg/myapp. Set it up, verify it answers 'how do I deploy?', and give me the embed
> snippet."*

The agent will create the app, ingest the docs, run the analyzer, test retrieval and chat, and
hand back the snippet.

## Remote Mascotly servers

The bundled MCP server operates on the store of the machine it runs on. To manage a **remote**
(Vercel/deployed) Mascotly, use its HTTP API from your agent instead — same tools are exposed as
REST endpoints (see [api.md](api.md)); the agent can call them with `fetch`/`curl` using your
admin key.

## Real-world example

This repository carries a live integration with a real open-source application:
[docsify](https://github.com/docsifyjs/docsify) (the documentation site generator). Its actual
repository docs are ingested through Mascotly's GitHub ingestor and Docsy 📚 answers questions
inside the real docsify docs site:

```bash
node integrations/docsify/seed.mjs     # ingest docsifyjs/docsify + analyze
node integrations/docsify/serve.mjs    # → http://localhost:4321
```
