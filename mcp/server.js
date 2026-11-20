#!/usr/bin/env node
// Mascotly MCP server — exposes Mascotly as tools over the Model Context Protocol
// (stdio transport, newline-delimited JSON-RPC 2.0). Zero dependencies.
//
// Register it with any harness agent:
//   mascot setup --client claude_code      (also: codex, cursor, windsurf,
//                                           gemini_cli, claude_desktop, vscode, generic)
// Or manually:
//   { "command": "node", "args": ["<repo>/mcp/server.js"] }
//
// Tools operate directly on the local Mascotly store (no HTTP server needed),
// so agents can create apps, ingest docs, analyze, and generate embed
// snippets end-to-end.
import { createStore } from '../src/store-factory.js';
import { config } from '../src/config.js';
import {
  ingestText, ingestUrl, ingestCrawl, ingestSitemap, ingestGithub, ingestFileContent,
} from '../src/knowledge/ingest.js';
import { knowledgeStats, searchApp, invalidateRetriever } from '../src/knowledge/service.js';
import { analyzeApp } from '../src/analysis/analyzer.js';
import { runReaIngest } from '../src/rea/service.js';
import { reaStatus } from '../src/rea/adapter.js';
import { chat } from '../src/brain/agent.js';
import { createJob } from '../src/jobs.js';
import { truncate } from '../src/util.js';

const VERSION = '0.1.0';

// ---------------------------------------------------------------- store

const store = await createStore();
if (typeof store.init === 'function') await store.init();

function requireApp(appId) {
  if (!appId) throw new Error('appId is required. Use mascot_list_apps to see available apps.');
  const app = store.getApp(String(appId));
  if (!app) throw new Error(`App not found: ${appId}. Use mascot_list_apps to see available apps.`);
  return app;
}

function appSummary(app) {
  return {
    id: app.id,
    name: app.name,
    slug: app.slug,
    mascot: app.mascot.name,
    knowledge: knowledgeStats(store, app),
    hasProfile: !!store.getProfile(app.id),
    messages: app.stats?.messages || 0,
  };
}

// ---------------------------------------------------------------- tool defs

const TOOLS = [
  {
    name: 'mascot_list_apps',
    description: 'List all configured Mascotly apps with their knowledge stats.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const apps = store.listApps().map(appSummary);
      return { apps };
    },
  },
  {
    name: 'mascot_create_app',
    description: 'Create a Mascotly app (one mascot identity for one host application). Optionally ingest a docs URL immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Host application name' },
        description: { type: 'string', description: 'What the host app does' },
        docsUrl: { type: 'string', description: 'Optional docs page URL to ingest right away' },
        mascotName: { type: 'string' },
        emoji: { type: 'string' },
        greeting: { type: 'string' },
      },
      required: ['name'],
    },
    async run(args) {
      if (!args.name || String(args.name).trim().length < 2) throw new Error('name is required (min 2 chars)');
      const app = store.createApp({
        name: String(args.name).trim().slice(0, 120),
        description: String(args.description || '').slice(0, 4000),
        mascot: {
          name: args.mascotName || undefined,
          emoji: args.emoji || undefined,
          greeting: args.greeting || undefined,
        },
      });
      let ingest = null;
      if (args.docsUrl) {
        try {
          ingest = await ingestUrl(store, app, { url: String(args.docsUrl) });
        } catch (err) {
          ingest = { error: truncate(String(err.message), 300) };
        }
      }
      return { app: { id: app.id, name: app.name, publicKey: app.publicKey, secretKey: app.secretKey }, ingest };
    },
  },
  {
    name: 'mascot_add_source',
    description: 'Add a knowledge source to an app. Types: text, url, crawl, sitemap, github, file, reviews. Runs inline and returns chunk counts.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        type: { type: 'string', enum: ['text', 'url', 'crawl', 'sitemap', 'github', 'file', 'reviews'] },
        label: { type: 'string' },
        text: { type: 'string', description: 'for text/reviews' },
        url: { type: 'string', description: 'for url/crawl/sitemap' },
        repo: { type: 'string', description: 'owner/name for github' },
        branch: { type: 'string' },
        content: { type: 'string', description: 'file content (text or base64)' },
        encoding: { type: 'string', enum: ['text', 'base64'] },
        maxPages: { type: 'number' },
      },
      required: ['appId', 'type'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      const type = String(args.type).toLowerCase();
      switch (type) {
        case 'text':
          return { ...(await ingestText(store, app, { label: args.label, text: args.text, kind: 'text' })) };
        case 'reviews':
          return { ...(await ingestText(store, app, { label: args.label || 'Reviews', text: args.text, kind: 'reviews' })) };
        case 'file':
          return { ...(await ingestFileContent(store, app, { label: args.label, content: args.content, encoding: args.encoding === 'base64' ? 'base64' : 'text' })) };
        case 'url':
          return { ...(await ingestUrl(store, app, { url: args.url, label: args.label })) };
        case 'crawl':
          return { ...(await ingestCrawl(store, app, { url: args.url, maxPages: Math.min(Number(args.maxPages) || 8, 25) }, () => {})) };
        case 'sitemap':
          return { ...(await ingestSitemap(store, app, { url: args.url, maxUrls: 20 }, () => {})) };
        case 'github':
          return { ...(await ingestGithub(store, app, { repo: args.repo, branch: args.branch }, () => {})) };
        default:
          throw new Error(`Unknown source type: ${type}`);
      }
    },
  },
  {
    name: 'mascot_analyze',
    description: 'Run the analyzer for an app: turns indexed knowledge into the app profile (purpose, features, limitations, FAQs) that powers the mascot.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
    async run(args) {
      const app = requireApp(args.appId);
      const profile = await analyzeApp(store, app, createJob(app.id, 'analyze', 'mcp analysis'));
      return {
        engine: profile.engine,
        summary: profile.summary,
        features: profile.features,
        limitations: profile.limitations,
        suggestions: profile.suggestions,
      };
    },
  },
  {
    name: 'mascot_get_profile',
    description: 'Get the current analyzer profile for an app.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
    async run(args) {
      const app = requireApp(args.appId);
      return { profile: store.getProfile(app.id) };
    },
  },
  {
    name: 'mascot_search',
    description: 'Search an app\'s knowledge base (the same hybrid retrieval the mascot uses).',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, query: { type: 'string' }, k: { type: 'number' } },
      required: ['appId', 'query'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      const results = await searchApp(store, app, String(args.query), Math.min(Number(args.k) || 8, 30));
      return {
        results: results.map((r) => ({
          label: r.chunk.meta?.label || r.chunk.meta?.title || '',
          heading: r.chunk.headingPath || '',
          url: r.chunk.meta?.url || '',
          score: Number((r.score ?? 0).toFixed(4)),
          text: truncate(r.chunk.text, 400),
        })),
      };
    },
  },
  {
    name: 'mascot_chat',
    description: 'Ask the mascot a question as an end user would — full pipeline (retrieval + brain + citations).',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, message: { type: 'string' }, sessionId: { type: 'string' } },
      required: ['appId', 'message'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      const done = await chat(store, app, { message: String(args.message), history: [], page: null });
      return {
        answer: done.answer,
        citations: done.citations?.map((c) => ({ n: c.n, label: c.label, url: c.url })),
        escalated: done.escalated,
        usage: done.usage,
      };
    },
  },
  {
    name: 'mascot_embed_snippet',
    description: 'Generate the ready-to-paste embed snippet (script tag + init + actions) for an app.',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, serverUrl: { type: 'string', description: 'Public Mascotly server origin, e.g. https://mascot.example.com' } },
      required: ['appId'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      let server = String(args.serverUrl || process.env.MASCOT_PUBLIC_URL || `http://localhost:${config.port}`).replace(/\/+$/, '');
      try {
        server = new URL(server).origin; // sanitize — this lands inside generated HTML/JS
      } catch {
        throw new Error(`Invalid serverUrl: ${server}`);
      }
      const actions = (app.mascot.actions || []).map((a) => a.name);
      const snippet = [
        `<script src="${server}/widget/mascot-widget.js"></script>`,
        '<script>',
        `  window.Mascotly.init({`,
        `    server: '${server}',`,
        `    appId: '${app.id}',`,
        `    publicKey: '${app.publicKey}'`,
        `  });`,
        actions.length ? `\n  // host actions: ${actions.join(', ')}\n  window.Mascotly.registerAction('<name>', (args) => { /* ... */ });` : '',
        '</script>',
      ].filter(Boolean).join('\n');
      return { appId: app.id, publicKey: app.publicKey, snippet, dashboardUrl: `${server}/dashboard/` };
    },
  },
  {
    name: 'mascot_add_skill',
    description: 'Install a SKILL.md-compatible capability pack into an app (agentskills.io format: markdown with optional frontmatter name/description). The mascot applies installed skills when relevant.',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, content: { type: 'string', description: 'SKILL.md markdown' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['appId', 'content'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      app.skills = Array.isArray(app.skills) ? app.skills : [];
      if (app.skills.length >= 12) throw new Error('Skill limit reached (12 per app)');
      const skill = {
        id: 'cap_' + Math.random().toString(36).slice(2, 10),
        name: String(args.name || 'skill').slice(0, 60),
        description: String(args.description || '').slice(0, 200),
        content: String(args.content).slice(0, 24_000),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      app.skills.push(skill);
      store.saveApp(app);
      invalidateRetriever(app.id);
      return { skillId: skill.id, name: skill.name };
    },
  },
  {
    name: 'mascot_add_tool',
    description: 'Register an HTTP tool plugin the mascot can call mid-chat (function-calling). Provide a snake_case name, a "when to use" description, and an endpoint that accepts JSON { args } and returns JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        name: { type: 'string', description: 'snake_case tool name' },
        description: { type: 'string' },
        url: { type: 'string' },
        method: { type: 'string', enum: ['GET', 'POST'] },
      },
      required: ['appId', 'name', 'description', 'url'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      app.tools = Array.isArray(app.tools) ? app.tools : [];
      const name = String(args.name || '').trim();
      if (!/^[a-z_][a-z0-9_]{1,40}$/.test(name)) throw new Error('tool name must be snake_case');
      if (app.tools.some((t) => t.name === name)) throw new Error(`Tool "${name}" already exists`);
      if (!/^https?:\/\//i.test(String(args.url))) throw new Error('url must start with http(s)://');
      const tool = {
        id: 'cap_' + Math.random().toString(36).slice(2, 10),
        name,
        description: String(args.description || '').slice(0, 300),
        url: String(args.url).slice(0, 600),
        method: args.method === 'GET' ? 'GET' : 'POST',
        headers: {},
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      app.tools.push(tool);
      store.saveApp(app);
      return { toolId: tool.id, name: tool.name };
    },
  },
  {
    name: 'mascot_add_hook',
    description: 'Register an HMAC-signed lifecycle webhook on an app. Events: message, escalation, feedback.',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, event: { type: 'string', enum: ['message', 'escalation', 'feedback'] }, url: { type: 'string' } },
      required: ['appId', 'event', 'url'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      if (!['message', 'escalation', 'feedback'].includes(args.event)) throw new Error('event must be message | escalation | feedback');
      if (!/^https?:\/\//i.test(String(args.url))) throw new Error('url must start with http(s)://');
      app.hooks = Array.isArray(app.hooks) ? app.hooks : [];
      const hook = {
        id: 'cap_' + Math.random().toString(36).slice(2, 10),
        event: args.event,
        url: String(args.url).slice(0, 600),
        secret: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
        enabled: true,
        createdAt: new Date().toISOString(),
        deliveries: [],
      };
      app.hooks.push(hook);
      store.saveApp(app);
      return { hookId: hook.id, event: hook.event, url: hook.url, secret: hook.secret, signingHeader: 'x-mascot-signature (sha256 HMAC of the raw body)' };
    },
  },
  {
    name: 'mascot_list_capabilities',
    description: 'List everything an app can do beyond chat: installed skills, HTTP tool plugins, and registered hooks.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' } }, required: ['appId'] },
    async run(args) {
      const app = requireApp(args.appId);
      return {
        skills: (app.skills || []).map((s) => ({ id: s.id, name: s.name, description: s.description, enabled: s.enabled !== false, chars: s.content?.length || 0 })),
        tools: (app.tools || []).map((t) => ({ id: t.id, name: t.name, description: t.description, url: t.url, method: t.method, enabled: t.enabled !== false })),
        hooks: (app.hooks || []).map((h) => ({ id: h.id, event: h.event, url: h.url, enabled: h.enabled !== false, lastDelivery: h.lastDelivery || null })),
      };
    },
  },
  {
    name: 'mascot_remove_capability',
    description: 'Remove one installed capability (skill / tool / hook) from an app.',
    inputSchema: {
      type: 'object',
      properties: { appId: { type: 'string' }, kind: { type: 'string', enum: ['skill', 'tool', 'hook'] }, id: { type: 'string' } },
      required: ['appId', 'kind', 'id'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      const key = args.kind === 'skill' ? 'skills' : args.kind === 'tool' ? 'tools' : 'hooks';
      const list = Array.isArray(app[key]) ? app[key] : [];
      const before = list.length;
      app[key] = list.filter((x) => x.id !== args.id);
      if (app[key].length === before) throw new Error(`${args.kind} not found: ${args.id}`);
      store.saveApp(app);
      if (args.kind === 'skill') invalidateRetriever(app.id);
      return { removed: args.id, kind: args.kind };
    },
  },
  {
    name: 'mascot_rea_status',
    description: 'Check whether the REA (Reverse Engineer Anything) CLI is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return reaStatus();
    },
  },
  {
    name: 'mascot_rea',
    description: 'Reverse-engineer a shipped artifact (Electron app dir, ASAR, JS tree) with REA and fold findings into the app knowledge. Needs the self-hosted mode and a local absolute path.',
    inputSchema: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        target: { type: 'string', description: 'absolute local path' },
        kind: { type: 'string', enum: ['javascript', 'asar', 'custom'] },
        command: { type: 'string', description: 'rea sub-command when kind=custom' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['appId', 'target'],
    },
    async run(args) {
      const app = requireApp(args.appId);
      return runReaIngest(store, app, args, () => {});
    },
  },
  {
    name: 'mascot_delete_app',
    description: 'Permanently delete an app and all its knowledge, sessions and settings.',
    inputSchema: { type: 'object', properties: { appId: { type: 'string' }, confirm: { type: 'boolean', description: 'must be true' } }, required: ['appId', 'confirm'] },
    async run(args) {
      if (args.confirm !== true) throw new Error('Pass confirm:true to actually delete.');
      const app = requireApp(args.appId);
      const name = app.name;
      store.deleteApp(app.id);
      invalidateRetriever(app.id);
      return { deleted: name };
    },
  },
];

// ---------------------------------------------------------------- JSON-RPC

function ok(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function err(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

async function handleMessage(line) {
  if (!line.trim()) return null;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return err(null, -32700, 'Parse error');
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      // Per MCP spec: respond with the server's latest supported version when
      // the client requests something we don't know.
      return ok(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[PROTOCOL_VERSIONS.length - 1],
        capabilities: { tools: {} },
        serverInfo: { name: 'mascot', version: VERSION },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null; // notifications get no response
    case 'ping':
      return isNotification ? null : ok(id, {});
    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return err(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const args = params?.arguments || {};
        const result = await tool.run(args, {});
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        // A tools/call sent as a notification gets no response frame.
        if (isNotification) return null;
        return ok(id, { content: [{ type: 'text', text }], isError: false });
      } catch (e) {
        if (isNotification) return null;
        return ok(id, { content: [{ type: 'text', text: String(e.message || e) }], isError: true });
      }
    }
    default:
      if (typeof method === 'string' && method.startsWith('notifications/')) return null;
      return isNotification ? null : err(id, -32601, `Method not found: ${method}`);
  }
}

async function main() {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  const MAX_BUFFER = 8 * 1024 * 1024; // 8 MB — reject runaway framing, never balloon memory
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_BUFFER) {
      process.stdout.write(err(null, -32700, 'Request too large') + '\n');
      buffer = '';
      return;
    }
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      handleMessage(line)
        .then((out) => {
          if (out) process.stdout.write(out + '\n');
        })
        .catch((e) => {
          process.stdout.write(err(null, -32603, String(e.message || e)) + '\n');
        });
    }
  });
  process.stdin.on('end', async () => {
    try {
      await store.flushAll?.();
    } catch { /* noop */ }
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    try {
      await store.flushAll?.();
    } catch { /* noop */ }
    process.exit(0);
  });
  if (process.stderr.isTTY) {
    process.stderr.write(`[mascot-mcp] v${VERSION} ready — ${store.listApps().length} app(s) loaded\n`);
  }
}

await main();
