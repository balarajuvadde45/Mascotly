// Admin / app-secret API: app lifecycle, knowledge sources, analysis, REA, sessions.
import { Router } from 'express';
import { config } from '../config.js';
import { asyncHandler, HttpError, makeAuth } from './middleware.js';
import { createJob, jobStep, finishJob, failJob, recordJob, getJob } from '../jobs.js';
import {
  ingestText, ingestUrl, ingestCrawl, ingestSitemap, ingestGithub, ingestFileContent,
  removeSource, commitSource, SOURCE_TYPES,
} from '../knowledge/ingest.js';
import { knowledgeStats, searchApp, invalidateRetriever } from '../knowledge/service.js';
import { analyzeApp } from '../analysis/analyzer.js';
import { reaStatus } from '../rea/adapter.js';
import { runReaIngest } from '../rea/service.js';
import { fireHooks, HOOK_EVENTS } from '../hooks.js';
import { forgeBotAsJob } from '../forge.js';
import { getLlm } from '../providers/llm.js';
import { truncate, slugify, secretKey, newId } from '../util.js';

const VERSION = '0.1.0';

function publicAppView(app) {
  const { secretKey, ...rest } = app;
  return { ...rest, secretKeyMasked: secretKey ? `…${secretKey.slice(-4)}` : null };
}

function fullAppView(app) {
  return app; // includes keys — only for admin/secret holders
}

/** Run ingest work; detached job on servers, inline on serverless.
 *  The ingestor owns source-record creation and returns { sourceId, ...commit }. */
async function runSourceWork(store, app, work, jobLabel) {
  if (config.serverless) {
    const result = await work(() => {});
    const out = { ok: true, inline: true, ...result };
    if (app.settings?.autoAnalyze && !store.getProfile(app.id)) {
      const aJob = createJob(app.id, 'analyze', 'auto-analysis after first source');
      try { await analyzeApp(store, app, aJob); } catch { /* recorded on job */ }
      out.analyzed = aJob.status === 'done';
    }
    return out;
  }
  const job = createJob(app.id, 'ingest', jobLabel);
  (async () => {
    try {
      const result = await work((name, detail, progress) => jobStep(job, name, detail, progress));
      finishJob(job, result);
      // First-time auto-analysis so a fresh app gets a profile without a manual step.
      if (app.settings?.autoAnalyze && !store.getProfile(app.id)) {
        const aJob = createJob(app.id, 'analyze', 'auto-analysis after first source');
        analyzeApp(store, app, aJob).catch(() => {});
      }
    } catch (err) {
      failJob(job, err);
    }
    recordJob(store, app, job);
  })();
  return { jobId: job.id };
}

/** Maybe trigger analysis (after sync ingests): inline on serverless, detached on servers. */
async function maybeAutoAnalyze(store, app) {
  if (!app.settings?.autoAnalyze) return;
  if (store.getProfile(app.id)) return;
  if (config.serverless) {
    const job = createJob(app.id, 'analyze', 'auto-analysis after first source');
    try { await analyzeApp(store, app, job); } catch { /* recorded on job */ }
    return;
  }
  const job = createJob(app.id, 'analyze', 'auto-analysis after first source');
  analyzeApp(store, app, job).catch(() => {});
  recordJob(store, app, job);
}

export function buildApiRouter(store) {
  const api = Router();
  const auth = makeAuth(store);

  // ---------- system ----------
  api.get('/health', (req, res) => {
    res.json({ ok: true, name: 'mascot', version: VERSION, uptimeSec: Math.round(process.uptime()) });
  });

  api.get('/system', auth.requireAdmin, asyncHandler(async (req, res) => {
    const llm = await import('../providers/llm.js').then((m) => m.getLlm({}));
    res.json({
      ok: true,
      version: VERSION,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      runtime: config.serverless ? 'serverless' : 'server',
      storage: config.store,
      providers: {
        llm: { provider: llm.provider, model: llm.model, configured: llm.configured },
        rea: await reaStatus(),
      },
      dataDir: config.store === 'file' ? config.dataDir : undefined,
    });
  }));

  // ---------- apps ----------
  api.post('/apps', auth.requireAdmin, asyncHandler(async (req, res) => {
    const { name, description, mascot, settings, docsUrl } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      throw new HttpError(400, 'name is required (min 2 chars)', 'invalid_name');
    }
    const app = store.createApp({
      name: name.trim().slice(0, 120),
      description: String(description || '').slice(0, 4000),
      mascot: mascot || {},
      settings: settings || {},
    });
    if (docsUrl) {
      try {
        const work = () => ingestUrl(store, app, { url: String(docsUrl) });
        if (config.serverless) {
          await runSourceWork(store, app, work, `docs ingest: ${truncate(String(docsUrl), 60)}`);
        } else {
          runSourceWork(store, app, work, `docs ingest: ${truncate(String(docsUrl), 60)}`).catch(() => {});
        }
      } catch { /* surfaced in sources */ }
    }
    res.status(201).json({ app: fullAppView(app) });
  }));

  api.get('/apps', auth.requireAdmin, asyncHandler(async (req, res) => {
    const apps = store.listApps().map((a) => {
      const view = publicAppView(a);
      view.knowledge = knowledgeStats(store, a);
      view.hasProfile = !!store.getProfile(a.id);
      return view;
    });
    res.json({ apps });
  }));

  api.get('/apps/:appId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ app: fullAppView(req.app), knowledge: knowledgeStats(store, req.app), hasProfile: !!store.getProfile(req.app.id) });
  }));

  api.patch('/apps/:appId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    if (b.name !== undefined) {
      if (typeof b.name !== 'string' || b.name.trim().length < 2) throw new HttpError(400, 'Invalid name');
      app.name = b.name.trim().slice(0, 120);
      app.slug = slugify(app.name);
    }
    if (b.description !== undefined) app.description = String(b.description || '').slice(0, 4000);
    if (b.mascot && typeof b.mascot === 'object') {
      const allowed = ['name', 'emoji', 'color', 'greeting', 'tagline', 'personality', 'welcome', 'suggestions', 'actions', 'avatarUrl', 'position'];
      for (const k of allowed) {
        if (b.mascot[k] !== undefined) app.mascot[k] = b.mascot[k];
      }
      if (Array.isArray(app.mascot.suggestions)) app.mascot.suggestions = app.mascot.suggestions.slice(0, 6);
      if (Array.isArray(app.mascot.actions)) {
        app.mascot.actions = app.mascot.actions
          .filter((a) => a && typeof a === 'object')
          .slice(0, 12)
          .map((a) => ({
            name: String(a.name || '').slice(0, 60),
            description: String(a.description || '').slice(0, 300),
            argsHint: String(a.argsHint || '').slice(0, 200),
          }));
      }
      if (app.mascot.position !== 'bottom-left') app.mascot.position = 'bottom-right';
    }
    if (b.settings && typeof b.settings === 'object') {
      for (const k of ['rateLimitPerMin', 'allowedOrigins', 'escalationKeywords', 'autoAnalyze', 'systemPromptExtra']) {
        if (b.settings[k] !== undefined) app.settings[k] = b.settings[k];
      }
      if (b.settings.model && typeof b.settings.model === 'object') {
        app.settings.model = {
          provider: String(b.settings.model.provider || 'auto').slice(0, 40),
          baseUrl: String(b.settings.model.baseUrl || '').slice(0, 300),
          model: String(b.settings.model.model || '').slice(0, 120),
          apiKey: String(b.settings.model.apiKey || '').slice(0, 300),
        };
      }
      if (b.settings.embeddings && typeof b.settings.embeddings === 'object') {
        app.settings.embeddings = {
          provider: String(b.settings.embeddings.provider || 'none').slice(0, 40),
          model: String(b.settings.embeddings.model || '').slice(0, 120),
          baseUrl: String(b.settings.embeddings.baseUrl || '').slice(0, 300),
          apiKey: String(b.settings.embeddings.apiKey || '').slice(0, 300),
        };
      }
      if (!Number.isFinite(Number(app.settings.rateLimitPerMin))) app.settings.rateLimitPerMin = 20;
    }
    store.saveApp(app);
    res.json({ app: fullAppView(app) });
  }));

  api.delete('/apps/:appId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    store.deleteApp(req.app.id);
    invalidateRetriever(req.app.id);
    res.json({ ok: true });
  }));

  api.post('/apps/:appId/keys/rotate', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const { secretKey: _ignored, publicKey: _ignored2 } = req.body || {};
    if (_ignored !== undefined || _ignored2 !== undefined) {
      throw new HttpError(400, 'Custom keys are not supported — keys are generated', 'invalid');
    }
    const app = req.app;
    app.secretKey = secretKey();
    app.publicKey = secretKey();
    store.saveApp(app);
    res.json({ ok: true, publicKey: app.publicKey, secretKey: app.secretKey });
  }));

  // ---------- analysis ----------
  api.get('/apps/:appId/profile', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ profile: store.getProfile(req.app.id) });
  }));

  api.post('/apps/:appId/analyze', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const job = createJob(req.app.id, 'analyze', 'manual analysis');
    if (config.serverless) {
      // Serverless functions cannot run detached work — analyze inline.
      try {
        const profile = await analyzeApp(store, req.app, job);
        res.json({
          ok: true,
          inline: true,
          jobId: job.id,
          result: { engine: profile.engine, features: profile.features?.length || 0, faqs: profile.faqs?.length || 0, summary: profile.summary },
        });
      } catch (err) {
        res.status(err.code === 'no_knowledge' ? 400 : 500).json({ error: err.code || 'analysis_failed', message: err.message });
      }
      return;
    }
    recordJob(store, req.app, job);
    analyzeApp(store, req.app, job).catch(() => {}); // failures recorded on the job
    res.status(202).json({ jobId: job.id, status: job.status });
  }));

  api.get('/apps/:appId/jobs/:jobId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const job = getJob(req.app.id, req.params.jobId);
    if (!job) throw new HttpError(404, 'Job not found (may have restarted)', 'not_found');
    res.json({ job });
  }));

  // ---------- knowledge sources ----------
  api.get('/apps/:appId/sources', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ sources: store.getSources(req.app.id), knowledge: knowledgeStats(store, req.app) });
  }));

  api.post('/apps/:appId/sources', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const b = req.body || {};
    const type = String(b.type || '').toLowerCase();
    if (!SOURCE_TYPES.includes(type)) throw new HttpError(400, `type must be one of: ${SOURCE_TYPES.join(', ')}`);
    const app = req.app;

    switch (type) {
      case 'text': {
        if (!b.text || typeof b.text !== 'string') throw new HttpError(400, 'text is required');
        if (b.text.length > config.limits.maxUploadChars) throw new HttpError(400, `Text too long (max ${config.limits.maxUploadChars} chars)`);
        const result = await ingestText(store, app, { label: b.label, text: b.text, url: b.url || '', kind: 'text' });
        await maybeAutoAnalyze(store, app);
        return res.status(201).json({ ok: true, ...result });
      }
      case 'reviews': {
        if (!b.text || typeof b.text !== 'string') throw new HttpError(400, 'text is required');
        if (b.text.length > config.limits.maxUploadChars) throw new HttpError(400, `Text too long (max ${config.limits.maxUploadChars} chars)`);
        const result = await ingestText(store, app, { label: b.label || 'Reviews', text: b.text, kind: 'reviews' });
        await maybeAutoAnalyze(store, app);
        return res.status(201).json({ ok: true, ...result });
      }
      case 'file': {
        if (!b.content || typeof b.content !== 'string') throw new HttpError(400, 'content is required');
        const result = await ingestFileContent(store, app, {
          label: b.label || 'Uploaded file',
          content: b.content,
          encoding: b.encoding === 'base64' ? 'base64' : 'text',
          mime: String(b.mime || ''),
        });
        await maybeAutoAnalyze(store, app);
        return res.status(201).json({ ok: true, ...result });
      }
      case 'url': {
        if (!b.url || !/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'url must start with http(s)://');
        const result = await runSourceWork(store, app, () => ingestUrl(store, app, { url: b.url, label: b.label }), `fetch: ${truncate(b.url, 70)}`);
        return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
      }
      case 'crawl': {
        if (!b.url || !/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'url must start with http(s)://');
        const result = await runSourceWork(store, app, (onStep) => ingestCrawl(store, app, { url: b.url, maxPages: b.maxPages, sameOrigin: b.sameOrigin !== false }, onStep), `crawl: ${truncate(b.url, 70)}`);
        return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
      }
      case 'sitemap': {
        if (!b.url || !/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'url must start with http(s)://');
        const result = await runSourceWork(store, app, (onStep) => ingestSitemap(store, app, { url: b.url, maxUrls: b.maxUrls }, onStep), `sitemap: ${truncate(b.url, 70)}`);
        return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
      }
      case 'github': {
        if (!b.repo || !/^[\w.-]+\/[\w.-]+$/.test(String(b.repo))) throw new HttpError(400, 'repo must look like owner/name');
        const result = await runSourceWork(store, app, (onStep) => ingestGithub(store, app, { repo: b.repo, branch: b.branch }, onStep), `github: ${b.repo}`);
        return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
      }
      case 'rea': {
        throw new HttpError(400, 'REA sources are created via POST /apps/:id/rea');
      }
      default:
        throw new HttpError(400, 'Unknown type');
    }
  }));

  api.delete('/apps/:appId/sources/:sourceId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const ok = removeSource(store, req.app, req.params.sourceId);
    if (!ok) throw new HttpError(404, 'Source not found', 'not_found');
    invalidateRetriever(req.app.id);
    res.json({ ok: true });
  }));

  api.post('/apps/:appId/sources/:sourceId/reingest', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const source = store.getSources(app.id).find((s) => s.id === req.params.sourceId);
    if (!source) throw new HttpError(404, 'Source not found', 'not_found');

    if (source.type === 'url') {
      const result = await runSourceWork(store, app, () => ingestUrl(store, app, { url: source.detail.url, label: source.label, source }), `re-fetch: ${truncate(source.detail.url, 70)}`);
      return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
    }
    if (source.type === 'crawl') {
      const result = await runSourceWork(store, app, (onStep) => ingestCrawl(store, app, { ...source.detail, source }, onStep), `re-crawl: ${truncate(source.detail.url, 70)}`);
      return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
    }
    if (source.type === 'sitemap') {
      const result = await runSourceWork(store, app, (onStep) => ingestSitemap(store, app, { ...source.detail, source }, onStep), `re-sitemap: ${truncate(source.detail.url, 70)}`);
      return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
    }
    if (source.type === 'github') {
      const result = await runSourceWork(store, app, (onStep) => ingestGithub(store, app, { ...source.detail, source }, onStep), `re-fetch: ${source.detail.repo}`);
      return res.status(result.jobId ? 202 : 200).json({ ok: true, ...result });
    }
    if ((source.type === 'text' || source.type === 'reviews') && source.detail?.text) {
      const result = await commitSource(store, app, source, [{
        title: source.label, url: source.detail.url || '', text: source.detail.text, label: source.label,
        kind: source.type === 'reviews' ? 'reviews' : 'text', sourceType: source.type,
      }], { reviews: source.type === 'reviews' });
      invalidateRetriever(app.id);
      return res.json({ ok: true, ...result });
    }
    throw new HttpError(400, `Re-ingest not available for source type "${source.type}"`, 'unsupported');
  }));

  api.post('/apps/:appId/search', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const { query, k } = req.body || {};
    if (!query || typeof query !== 'string') throw new HttpError(400, 'query is required');
    const results = await searchApp(store, req.app, query, Math.min(Number(k) || 8, 30));
    res.json({
      query,
      results: results.map((r) => ({
        chunkId: r.chunk.id,
        sourceId: r.chunk.sourceId,
        label: r.chunk.meta?.label || r.chunk.meta?.title || '',
        heading: r.chunk.headingPath || '',
        url: r.chunk.meta?.url || '',
        score: Number((r.score ?? 0).toFixed(4)),
        bm25: r.bm25 != null ? Number(r.bm25.toFixed(4)) : null,
        cosine: r.cosine != null ? Number(r.cosine.toFixed(4)) : null,
        text: truncate(r.chunk.text, 500),
      })),
    });
  }));

  // ---------- capabilities: Skills / Tools / Hooks ----------
  // Skills = SKILL.md-compatible instruction packs (agentskills.io format).
  // Tools  = HTTP tool plugins callable by the mascot mid-chat.
  // Hooks  = HMAC-signed lifecycle webhooks (message / escalation / feedback).

  function parseSkillMarkdown(raw) {
    const text = String(raw || '').replace(/\r\n/g, '\n').trim();
    let name = '';
    let description = '';
    let body = text;
    const fm = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (fm) {
      for (const line of fm[1].split('\n')) {
        const m = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'name') name = m[2].trim().replace(/^["']|["']$/g, '');
        if (m[1].toLowerCase() === 'description') description = m[2].trim().replace(/^["']|["']$/g, '');
      }
      body = fm[2].trim();
    }
    if (!name) {
      const h = body.match(/^#\s+(.{2,60})\s*$/m);
      if (h) name = h[1].trim();
    }
    return { name: (name || 'unnamed skill').slice(0, 60), description: description.slice(0, 200), content: body.slice(0, 24_000) };
  }

  const genId = () => newId('cap');

  api.get('/apps/:appId/skills', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ skills: req.app.skills || [] });
  }));

  api.post('/apps/:appId/skills', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    if (!b.content || typeof b.content !== 'string' || !b.content.trim()) throw new HttpError(400, 'content (SKILL.md markdown) is required');
    if (b.content.length > 60_000) throw new HttpError(400, 'Skill too large (max 60k chars)');
    const parsed = parseSkillMarkdown(b.content);
    const skill = {
      id: genId(),
      name: String(b.name || parsed.name).slice(0, 60),
      description: String(b.description || parsed.description).slice(0, 200),
      content: parsed.content,
      enabled: b.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    app.skills = Array.isArray(app.skills) ? app.skills : [];
    if (app.skills.length >= 12) throw new HttpError(400, 'Skill limit reached (12 per app)');
    app.skills.push(skill);
    store.saveApp(app);
    invalidateRetriever(app.id);
    res.status(201).json({ ok: true, skill });
  }));

  api.patch('/apps/:appId/skills/:skillId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const skill = (req.app.skills || []).find((s) => s.id === req.params.skillId);
    if (!skill) throw new HttpError(404, 'Skill not found', 'not_found');
    if (req.body?.enabled !== undefined) skill.enabled = !!req.body.enabled;
    store.saveApp(req.app);
    res.json({ ok: true, skill });
  }));

  api.delete('/apps/:appId/skills/:skillId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const before = (app.skills || []).length;
    app.skills = (app.skills || []).filter((s) => s.id !== req.params.skillId);
    if (app.skills.length === before) throw new HttpError(404, 'Skill not found', 'not_found');
    store.saveApp(app);
    res.json({ ok: true });
  }));

  api.get('/apps/:appId/tools', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ tools: req.app.tools || [] });
  }));

  api.post('/apps/:appId/tools', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!/^[a-z_][a-z0-9_]{1,40}$/.test(name)) throw new HttpError(400, 'tool name must be snake_case (a-z, 0-9, _)');
    if (!b.url || !/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'url must start with http(s)://');
    if (!b.description || String(b.description).trim().length < 8) throw new HttpError(400, 'description (>=8 chars) tells the mascot when to use the tool');
    const method = String(b.method || 'POST').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new HttpError(400, 'method must be GET or POST');
    const headers = {};
    if (b.headers && typeof b.headers === 'object' && !Array.isArray(b.headers)) {
      for (const [k, v] of Object.entries(b.headers).slice(0, 8)) {
        if (/^[\w-]{1,60}$/.test(k) && typeof v === 'string' && v.length <= 400) headers[k] = v;
      }
    }
    app.tools = Array.isArray(app.tools) ? app.tools : [];
    if (app.tools.length >= 8) throw new HttpError(400, 'Tool limit reached (8 per app)');
    if (app.tools.some((t) => t.name === name)) throw new HttpError(400, `Tool "${name}" already exists`);
    const tool = {
      id: genId(),
      name,
      description: String(b.description).slice(0, 300),
      url: String(b.url).slice(0, 600),
      method,
      headers,
      enabled: b.enabled !== false,
      createdAt: new Date().toISOString(),
    };
    app.tools.push(tool);
    store.saveApp(app);
    res.status(201).json({ ok: true, tool });
  }));

  api.patch('/apps/:appId/tools/:toolId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const tool = (req.app.tools || []).find((t) => t.id === req.params.toolId);
    if (!tool) throw new HttpError(404, 'Tool not found', 'not_found');
    if (req.body?.enabled !== undefined) tool.enabled = !!req.body.enabled;
    store.saveApp(req.app);
    res.json({ ok: true, tool });
  }));

  api.delete('/apps/:appId/tools/:toolId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const before = (app.tools || []).length;
    app.tools = (app.tools || []).filter((t) => t.id !== req.params.toolId);
    if (app.tools.length === before) throw new HttpError(404, 'Tool not found', 'not_found');
    store.saveApp(app);
    res.json({ ok: true });
  }));

  api.get('/apps/:appId/hooks', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ hooks: (req.app.hooks || []).map(({ secret, ...h }) => ({ ...h, secretSet: !!secret })) });
  }));

  api.post('/apps/:appId/hooks', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    if (!HOOK_EVENTS.includes(b.event)) throw new HttpError(400, `event must be one of: ${HOOK_EVENTS.join(', ')}`);
    if (!b.url || !/^https?:\/\//i.test(b.url)) throw new HttpError(400, 'url must start with http(s)://');
    try { new URL(b.url); } catch { throw new HttpError(400, 'url is not a valid URL'); }
    app.hooks = Array.isArray(app.hooks) ? app.hooks : [];
    if (app.hooks.length >= 8) throw new HttpError(400, 'Hook limit reached (8 per app)');
    const hook = {
      id: genId(),
      event: b.event,
      url: String(b.url).slice(0, 600),
      secret: b.secret ? String(b.secret).slice(0, 200) : secretKey(16),
      enabled: b.enabled !== false,
      createdAt: new Date().toISOString(),
      deliveries: [],
    };
    app.hooks.push(hook);
    store.saveApp(app);
    res.status(201).json({ ok: true, hook: { ...hook, secret: undefined, secretSet: !!hook.secret } });
  }));

  api.delete('/apps/:appId/hooks/:hookId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const before = (app.hooks || []).length;
    app.hooks = (app.hooks || []).filter((h) => h.id !== req.params.hookId);
    if (app.hooks.length === before) throw new HttpError(404, 'Hook not found', 'not_found');
    store.saveApp(app);
    res.json({ ok: true });
  }));

  api.post('/apps/:appId/hooks/:hookId/test', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const hook = (app.hooks || []).find((h) => h.id === req.params.hookId);
    if (!hook) throw new HttpError(404, 'Hook not found', 'not_found');
    fireHooks(store, app, hook.event, { test: true, message: 'This is a Mascotly hook test delivery.' });
    res.json({ ok: true, message: 'Test delivery fired — check the delivery log in a few seconds.' });
  }));

  // Plugin manifest: export/import reusable skills + tools (hooks stay deployment-local).
  api.get('/apps/:appId/plugin-manifest', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    res.json({
      manifest: {
        format: 'mascotly-plugin/1',
        name: `${app.name} capabilities`,
        exportedAt: new Date().toISOString(),
        skills: app.skills || [],
        tools: app.tools || [],
      },
    });
  }));

  api.post('/apps/:appId/plugin-manifest', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const m = req.body?.manifest || req.body || {};
    if (m.format && m.format !== 'mascotly-plugin/1') throw new HttpError(400, 'Unsupported manifest format');
    const imported = { skills: 0, tools: 0 };
    app.skills = Array.isArray(app.skills) ? app.skills : [];
    for (const sk of (Array.isArray(m.skills) ? m.skills : []).slice(0, 12)) {
      if (!sk || !sk.content) continue;
      if (app.skills.some((x) => x.name === sk.name)) continue;
      if (app.skills.length >= 12) break;
      app.skills.push({
        id: genId(), name: String(sk.name || 'skill').slice(0, 60),
        description: String(sk.description || '').slice(0, 200),
        content: String(sk.content).slice(0, 24_000), enabled: sk.enabled !== false, createdAt: new Date().toISOString(),
      });
      imported.skills++;
    }
    app.tools = Array.isArray(app.tools) ? app.tools : [];
    for (const t of (Array.isArray(m.tools) ? m.tools : []).slice(0, 8)) {
      if (!t || !t.name || !t.url) continue;
      if (app.tools.some((x) => x.name === t.name)) continue;
      if (app.tools.length >= 8) break;
      app.tools.push({
        id: genId(), name: String(t.name).slice(0, 42), description: String(t.description || '').slice(0, 300),
        url: String(t.url).slice(0, 600), method: ['GET', 'POST'].includes(String(t.method || '').toUpperCase()) ? String(t.method).toUpperCase() : 'POST',
        headers: (t.headers && typeof t.headers === 'object') ? t.headers : {},
        enabled: t.enabled !== false, createdAt: new Date().toISOString(),
      });
      imported.tools++;
    }
    store.saveApp(app);
    invalidateRetriever(app.id);
    res.json({ ok: true, imported });
  }));

  // ---------- Forge (repo → bot) ----------
  // Global forge-job poll (no appId yet — the job creates one).
  api.get('/forge/jobs/:jobId', auth.requireAdmin, asyncHandler(async (req, res) => {
    const { getJob } = await import('../jobs.js');
    const job = getJob('forge', req.params.jobId);
    if (!job) throw new HttpError(404, 'Job not found (may have restarted)', 'not_found');
    res.json({ job });
  }));

  api.post('/forge', auth.requireAdmin, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (!b.repo || typeof b.repo !== 'string') throw new HttpError(400, 'repo (owner/name or GitHub URL) is required');
    if (config.serverless) {
      // Inline on serverless: bounded by the function duration.
      try {
        const llm = getLlm({});
        const result = await forgeBotAsJob(store, llm, { repo: b.repo, intent: b.intent, githubToken: b.githubToken, serverUrl: b.serverUrl, vercelToken: b.vercelToken }).promise;
        res.json({ ok: true, inline: true, result });
      } catch (err) {
        res.status(err.code === 'no_knowledge' ? 400 : 500).json({ error: 'forge_failed', message: err.message });
      }
      return;
    }
    const { job, promise } = forgeBotAsJob(store, getLlm({}), {
      repo: b.repo,
      intent: b.intent,
      githubToken: b.githubToken,
      serverUrl: b.serverUrl,
      vercelToken: b.vercelToken,
    });
    // Record the job against the app once it exists (the job creates it).
    promise.then((result) => {
      const app = store.getApp(result.appId);
      if (app) recordJob(store, app, job);
    }).catch(() => {});
    res.status(202).json({ jobId: job.id, status: job.status });
  }));

  // ---------- REA ----------
  api.get('/apps/:appId/rea/status', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json(await reaStatus());
  }));

  api.post('/apps/:appId/rea', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const app = req.app;
    const b = req.body || {};
    if (!b.target || typeof b.target !== 'string') throw new HttpError(400, 'target (absolute local path) is required');
    if (config.serverless) {
      throw new HttpError(400, 'REA analysis shells out to a local CLI and needs the self-hosted (server/Docker) mode — it cannot run inside serverless functions.');
    }
    const job = createJob(app.id, 'rea', `REA: ${truncate(String(b.target), 80)}`);
    recordJob(store, app, job);
    (async () => {
      try {
        const result = await runReaIngest(store, app, b, (name, detail, progress) => jobStep(job, name, detail, progress));
        finishJob(job, result);
      } catch (err) {
        failJob(job, err);
      }
      recordJob(store, app, job);
    })();
    res.status(202).json({ jobId: job.id, status: job.status });
  }));

  // ---------- sessions ----------
  api.get('/apps/:appId/sessions', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ sessions: store.listSessions(req.app.id) });
  }));

  api.get('/apps/:appId/sessions/:sessionId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    const session = store.getSession(req.app.id, req.params.sessionId);
    if (!session) throw new HttpError(404, 'Session not found', 'not_found');
    res.json({ session });
  }));

  api.delete('/apps/:appId/sessions/:sessionId', auth.requireAppAccess, asyncHandler(async (req, res) => {
    res.json({ ok: store.deleteSession(req.app.id, req.params.sessionId) });
  }));

  return api;
}

export { VERSION, publicAppView };
