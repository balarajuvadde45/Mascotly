// Tool registries for the agentic loop.
// Chat tools: available to the mascot in conversations.
// Forge tools: available to the forge agent for the repo→bot pipeline.
import { searchApp, knowledgeStats } from './knowledge/service.js';
import { ingestGithub, ingestUrl } from './knowledge/ingest.js';
import { analyzeApp } from './analysis/analyzer.js';
import { createJob, jobStep } from './jobs.js';
import { truncate } from './util.js';

/**
 * Chat-mode tools — the mascot can chain these to answer complex questions.
 * @param {object} store
 * @param {object} app
 * @param {function} recallMemory — memory recall function
 */
export function buildChatTools(store, app, { recallMemory, callHttpTool }) {
  const tools = [];

  // Knowledge search
  tools.push({
    name: 'search_knowledge',
    description: 'Search the indexed knowledge base for more information. Use when the initial context is insufficient.',
    execute: async (args) => {
      const query = String(args.query || args.q || '');
      if (!query) return { error: 'query is required' };
      const results = await searchApp(store, app, query, 6);
      return results.map((r) => ({
        heading: r.chunk.headingPath || '',
        text: truncate(r.chunk.text, 400),
        url: r.chunk.meta?.url || '',
      }));
    },
  });

  // HTTP tool plugins
  tools.push({
    name: 'call_tool',
    description: 'Call an HTTP tool plugin registered for this app (live API calls).',
    execute: async (args) => {
      const toolName = String(args.tool || args.name || '');
      const tools = Array.isArray(app.tools) ? app.tools : [];
      const tool = tools.find((t) => t.name === toolName && t.enabled !== false);
      if (!tool) return { error: `Unknown tool: ${toolName}. Available: ${tools.map((t) => t.name).join(', ')}` };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const method = tool.method || 'POST';
        const fetchOpts = {
          method,
          headers: { 'content-type': 'application/json', 'user-agent': 'MascotlyAgent/0.1', ...(tool.headers || {}) },
          signal: controller.signal,
          redirect: 'error',
        };
        if (method === 'POST') fetchOpts.body = JSON.stringify({ args: args.args || args, context: {} });
        const res = await fetch(tool.url, fetchOpts);
        const body = (await res.text()).slice(0, 32_000);
        return { status: res.status, ok: res.ok, body };
      } catch (err) {
        return { error: String(err.message || err).slice(0, 300) };
      } finally {
        clearTimeout(timer);
      }
    },
  });

  // Memory recall
  if (recallMemory) {
    tools.push({
      name: 'recall_conversation',
      description: 'Recall relevant past conversation turns from memory (this user\'s history).',
      execute: async (args) => {
        const query = String(args.query || args.q || '');
        if (!query) return { error: 'query is required' };
        const results = await recallMemory(store, app, { query, sessionId: args.sessionId, k: 5 });
        return results.map((r) => ({ text: r.text, from: r.sessionId, at: r.at }));
      },
    });
  }

  // Host actions (if registered)
  const actions = (Array.isArray(app.mascot?.actions) ? app.mascot.actions : []);
  for (const action of actions) {
    if (action.name === 'escalate') continue; // handled by the action protocol
    tools.push({
      name: `action_${action.name}`,
      description: `Trigger the host app action "${action.name}": ${truncate(action.description || '', 160)}`,
      execute: async (args) => {
        return { triggered: action.name, args, note: 'Host action emitted — the widget will dispatch it.' };
      },
    });
  }

  return tools;
}

/**
 * Forge-mode tools — the LLM drives the entire repo→bot pipeline.
 * @param {object} store
 * @param {object} app — the draft app (already created)
 * @param {object} opts { githubToken, onStep }
 */
export function buildForgeTools(store, app, { githubToken, onStep = () => {} } = {}) {
  const tools = [];
  const step = (name, detail) => onStep(name, detail);

  tools.push({
    name: 'ingest_github',
    description: 'Ingest a GitHub repository (README + docs trees) into the mascot\'s knowledge. Use first for repo-based bots.',
    execute: async (args) => {
      const { ingestGithub } = await import('./knowledge/ingest.js');
      const { fetchGithubRepo } = await import('./knowledge/crawler.js');
      step('ingesting repo…', 'fetching docs');
      const result = await ingestGithub(store, app, { repo: args.repo || '', token: githubToken }, (n, d) => step(n, d));
      return { chunks: result.chunkCount, docs: result.docCount, chars: result.charCount };
    },
  });

  tools.push({
    name: 'ingest_url',
    description: 'Ingest a web page URL into the mascot\'s knowledge.',
    execute: async (args) => {
      const { ingestUrl } = await import('./knowledge/ingest.js');
      step('ingesting URL…', args.url || '');
      return ingestUrl(store, app, { url: args.url || '', label: args.label || '' });
    },
  });

  tools.push({
    name: 'get_knowledge_stats',
    description: 'Check what\'s currently indexed: chunk count, sources, coverage.',
    execute: async () => {
      return knowledgeStats(store, app);
    },
  });

  tools.push({
    name: 'set_identity',
    description: 'Design the mascot\'s identity: name, emoji, color, tagline, personality, greeting, suggestions.',
    execute: async (args) => {
      app.mascot = {
        ...app.mascot,
        name: truncate(String(args.name || app.mascot.name), 24),
        emoji: (args.emoji || app.mascot.emoji).slice(0, 4),
        color: /^#[0-9a-fA-F]{6}$/.test(args.color || '') ? args.color : app.mascot.color,
        tagline: truncate(String(args.tagline || app.mascot.tagline), 60),
        personality: truncate(String(args.personality || app.mascot.personality), 400),
        greeting: truncate(String(args.greeting || app.mascot.greeting), 300),
        suggestions: Array.isArray(args.suggestions) ? args.suggestions.slice(0, 4).map((q) => truncate(q, 140)) : app.mascot.suggestions,
      };
      store.saveApp(app);
      step('identity set', `${app.mascot.emoji} ${app.mascot.name}`);
      return { identity: { name: app.mascot.name, emoji: app.mascot.emoji, tagline: app.mascot.tagline } };
    },
  });

  tools.push({
    name: 'add_skill',
    description: 'Install a SKILL.md-compatible capability pack into the mascot.',
    execute: async (args) => {
      app.skills = Array.isArray(app.skills) ? app.skills : [];
      if (app.skills.length >= 12) return { error: 'skill limit reached' };
      const skill = {
        id: 'cap_' + Math.random().toString(36).slice(2, 10),
        name: truncate(String(args.name || 'skill'), 60),
        description: truncate(String(args.description || ''), 200),
        content: truncate(String(args.content || ''), 6000),
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      app.skills.push(skill);
      store.saveApp(app);
      step('skill installed', skill.name);
      return { skillId: skill.id, name: skill.name };
    },
  });

  tools.push({
    name: 'run_analyzer',
    description: 'Run the analyzer: generates the app profile (summary, features, limitations, FAQs) from indexed knowledge.',
    execute: async (args) => {
      step('running analyzer…', 'synthesizing profile');
      const job = createJob(app.id, 'analyze', 'forge agent analysis');
      const profile = await analyzeApp(store, app, job);
      return {
        engine: profile.engine,
        summary: profile.summary,
        features: profile.features?.length || 0,
        faqs: profile.faqs?.length || 0,
      };
    },
  });

  tools.push({
    name: 'get_profile',
    description: 'Read the current app profile (summary, features, limitations).',
    execute: async () => {
      return { profile: store.getProfile(app.id) };
    },
  });

  return tools;
}
