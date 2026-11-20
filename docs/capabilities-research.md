# Capabilities research (Nov 2026) — what the era offers and what Mascotly ships

Research pass that shaped the capabilities layer. Sources cited inline.

## The ecosystem right now

| Development | What it is | Mascotly's answer |
| --- | --- | --- |
| **MCP donated to the Linux Foundation**; 17,000+ servers, 400M+ monthly SDK downloads; 2026-07-28 spec makes agent infrastructure "stateless, cacheable, routable" ([blog.modelcontextprotocol.io](https://blog.modelcontextprotocol.io/posts/2026-07-28), [anthropic.com](https://www.anthropic.com/news/model-context-protocol)) | MCP is THE integration standard; OpenAI adopted it across Agents SDK/ChatGPT (early 2025) | Mascotly ships its own zero-dep MCP server (`mcp/server.js`) exposing the whole workflow to Claude Code, Codex, Cursor, Gemini CLI, VS Code |
| **A2A protocol** (Google → Linux Foundation, June 2025; 150+ orgs by April 2026, enterprise production) — agent-to-agent discovery/communication via Agent Cards ([linuxfoundation.org](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), [a2a-protocol.org](https://a2a-protocol.org/latest)) | Agents must interoperate, not just consume tools | Mascotly's public HTTP API (documented, key-scoped) acts as its Agent Card surface; hooks/tools make it callable by other agents |
| **Agent Skills → open standard** (SKILL.md, agentskills.io): a directory with `SKILL.md` (instructions + optional resources) is all it takes; portable across Claude, ChatGPT, Cursor, Gemini CLI ([platform.claude.com](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)) | Skills = modular, portable instruction packs | Mascotly apps accept **SKILL.md packs** pasted/uploaded per app — parsed (frontmatter name/description) and injected into the mascot's brain |
| **Hooks** (Claude Code's extension model: skills + hooks + plugins) — lifecycle event triggers | React to agent lifecycle moments | Mascotly **Hooks**: signed HMAC-SHA256 webhooks on `message` / `escalation` / `feedback` events |
| **Plugins** — reusable bundles of skills/connectors distributed through plugin directories | Package once, reuse everywhere | Mascotly **Tool plugins**: per-app HTTP tools (name + description + endpoint) the mascot can call mid-chat through its JSON tool protocol; skills+hooks+tools export/import as a plugin manifest |
| **Jevons-paradox era** (Nadella on DeepSeek, Jan 2025; [Fortune](https://fortune.com/2025/01/27/microsoft-ceo-satya-nadella-deepseek-optimism-jevons-paradox), [NYT](https://www.nytimes.com/2025/02/14/business/deepseek-openai-jevons-paradox.html)) — cheaper inference → *more* usage → multi-provider strategies | Efficiency expands the market; hedge across providers | Mascotly is provider-agnostic by design (any OpenAI-compatible, Anthropic, Groq, Ollama) + a deterministic offline brain — the multi-provider strategy built in |
| **UI consensus for dev tools** (Linear/Vercel/Stripe pattern: dark, hairline borders, restrained accent, show the product, tight typography — [adminlte.io](https://adminlte.io/blog/saas-landing-page-design-examples), [spell.sh](https://spell.sh/blog/best-saas-landing-pages)) | Product-first minimal design | Mascotly UI: Inter + Space Grotesk, near-black palette, hairline borders, real product surfaces in the hero |
| **Three.js practice** (vanilla over R3F for bundle size; GPU-driven points/instancing; minimal lights; dispose resources; [mdx.so](https://mdx.so/blog/webgl-vs-three-js-which-technology-for-your-3d-website)) | Real 3D without wrecking performance | Vendored three.module.js, one GPU-friendly Points scene in the hero, DPR-capped, pauses when hidden |

## What shipped (implementation map)

- **Skills** → `app.skills[]`, `POST /api/apps/:id/skills` (paste raw SKILL.md; frontmatter parsed), injected into the brain prompt as capability packs.
- **Hooks** → `app.hooks[]`, HMAC-SHA256-signed deliveries for message/escalation/feedback, last-delivery status surfaced in the dashboard.
- **Tool plugins** → `app.tools[]`, callable mid-chat via the existing JSON tool protocol (`{"mascot_tool":{"name":"call_tool","tool":"<name>","args":{…}}}`), response fed back for the final answer.
- **Plugin manifest** → `GET /api/apps/:id/plugin-manifest` exports skills+hooks+tools for reuse; `POST` imports.
