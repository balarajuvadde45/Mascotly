// The analyzer: turns indexed knowledge into a structured understanding of the
// host app (purpose, features, audience, limitations, FAQs, tone, suggested
// starter questions) that the mascot's brain uses as its identity core.
//
// Two engines:
//   - LLM map-reduce (when a provider is configured)
//   - Extractive heuristics (always available; also the fallback on LLM failure)
import { getLlm } from '../providers/llm.js';
import { ANALYZE_BATCH, ANALYZE_REDUCE, fill, GUARDRAILS } from '../prompts.js';
import { truncate, stripCodeFence, extractJsonObject, nowIso, cleanText } from '../util.js';
import { jobStep, finishJob, failJob, recordJob } from '../jobs.js';

const GENERIC_HEADINGS = new Set([
  'introduction', 'overview', 'getting started', 'gettingstarted', 'install', 'installation',
  'setup', 'quickstart', 'quick start', 'contents', 'table of contents', 'readme', 'home',
  'index', 'welcome', 'faq', 'support', 'contact', 'license', 'changelog', 'api', 'docs',
  'documentation', 'section 1', 'overview', 'summary',
]);

function profileFromLlmBatches(batches) {
  return {
    purpose: batches.map((b) => b.purpose).filter(Boolean)[0] || '',
    summary: batches.map((b) => b.summary).filter(Boolean).join(' ').slice(0, 1200),
    features: dedupe(batches.flatMap((b) => Array.isArray(b.features) ? b.features : [])),
    audience: batches.map((b) => b.audience).filter(Boolean)[0] || '',
    limitations: dedupe(batches.flatMap((b) => Array.isArray(b.limitations) ? b.limitations : [])),
    faqs: dedupeFaqs(batches.flatMap((b) => Array.isArray(b.faqs) ? b.faqs : [])),
    tone: batches.map((b) => b.tone).filter(Boolean)[0] || '',
  };
}

function dedupe(items, cap = 24) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const s = String(item || '').trim().slice(0, 200);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function dedupeFaqs(faqs, cap = 10) {
  const seen = new Set();
  const out = [];
  for (const f of faqs) {
    if (!f || typeof f !== 'object') continue;
    const q = String(f.q || f.question || '').trim().slice(0, 240);
    const a = String(f.a || f.answer || '').trim().slice(0, 800);
    if (!q || !a) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ q, a });
    if (out.length >= cap) break;
  }
  return out;
}

async function llmJsonCall(llm, messages, maxTokens = 1400) {
  const res = await llm.chat(messages, { temperature: 0.2, maxTokens });
  const text = stripCodeFence(res.text || '');
  const parsed = extractJsonObject(text) || {};
  return parsed;
}

function batchChunks(chunks, targetChars = 6000, maxBatches = 10) {
  const batches = [];
  let current = [];
  let size = 0;
  for (const c of chunks) {
    if (current.length >= 8 || size + c.text.length > targetChars) {
      if (current.length) batches.push(current);
      current = [];
      size = 0;
    }
    current.push(c);
    size += c.text.length;
    if (batches.length >= maxBatches) break;
  }
  if (current.length && batches.length < maxBatches) batches.push(current);
  // If corpus is larger than sampled, add a spread sample from the tail.
  if (batches.length === maxBatches && chunks.length > 0) {
    const step = Math.max(1, Math.floor(chunks.length / maxBatches));
    const tailSample = [];
    for (let i = Math.floor(chunks.length / 2); i < chunks.length && tailSample.length < 6; i += step) {
      tailSample.push(chunks[i]);
    }
    batches[maxBatches - 1] = tailSample.length ? tailSample : batches[maxBatches - 1];
  }
  return batches;
}

async function analyzeWithLlm(store, app, chunks, llm, job) {
  jobStep(job, 'planning', `${chunks.length} knowledge chunks`, 10);
  const batches = batchChunks(chunks);
  const partials = [];

  for (let i = 0; i < batches.length; i++) {
    const texts = batches[i].map((c, idx) => {
      const src = c.meta?.label || c.meta?.title || 'knowledge';
      return `(#${idx + 1}, source: ${truncate(src, 80)})\n${truncate(c.text, 2200)}`;
    }).join('\n\n---\n\n');
    try {
      // Centralized prompts (src/prompts.js): system carries the role + guardrails,
      // user carries the per-batch material.
      const parsed = await llmJsonCall(llm, [
        { role: 'system', content: fill(ANALYZE_BATCH, { guardrails: GUARDRAILS, texts: '' }).split('Material:')[0].trim() },
        { role: 'user', content: fill(ANALYZE_BATCH, { guardrails: '', texts }) },
      ]);
      partials.push(parsed);
    } catch (err) {
      console.warn(`[analyzer] batch ${i + 1} failed: ${err.message}`);
    }
    jobStep(job, `analyzed batch ${i + 1}/${batches.length}`, '', 10 + Math.round(((i + 1) / batches.length) * 60));
  }

  if (!partials.length) throw new Error('All LLM analysis batches failed');

  jobStep(job, 'synthesizing profile', '', 80);
  const merged = profileFromLlmBatches(partials);
  const reduced = await llmJsonCall(llm, [
    { role: 'system', content: fill(ANALYZE_REDUCE, { guardrails: GUARDRAILS, notes: '' }).split('Here are analyst notes')[0].trim() },
    {
      role: 'user',
      content: fill(ANALYZE_REDUCE, { guardrails: '', notes: JSON.stringify(partials, null, 1).slice(0, 14_000) }),
    },
  ], 1600);

  const profile = {
    summary: truncate(String(reduced.summary || merged.summary || ''), 1200),
    purpose: truncate(String(reduced.purpose || merged.purpose || ''), 400),
    features: dedupe(reduced.features || merged.features, 14),
    audience: truncate(String(reduced.audience || merged.audience || ''), 300),
    limitations: dedupe(reduced.limitations || merged.limitations, 8),
    faqs: dedupeFaqs(reduced.faqs || merged.faqs, 8),
    tone: truncate(String(reduced.tone || merged.tone || ''), 200),
    suggestions: dedupe(reduced.suggestions || [], 6),
    confidence: 'llm',
  };
  return profile;
}

function analyzeHeuristically(store, app, chunks, sources) {
  const features = [];
  const faqs = [];
  const limitations = [];
  let summaryBody = '';

  // Features from headings that look meaningful.
  for (const c of chunks) {
    const h = String(c.headingPath || '').split('›').pop().trim().toLowerCase();
    if (h && h.length > 3 && h.length < 60 && !GENERIC_HEADINGS.has(h)) {
      features.push(c.headingPath.split('›').pop().trim());
    }
    // FAQ-ish patterns.
    const text = c.text;
    const qa = text.match(/^Q:\s*(.{5,140}?)\n+A:\s*(.{5,600})/gm);
    if (qa) {
      for (const m of qa) {
        const [, q, a] = m.match(/^Q:\s*(.*?)\n+A:\s*([\s\S]*)$/) || [];
        if (q && a) faqs.push({ q: q.trim(), a: truncate(a.trim(), 500) });
      }
    }
    // Bullet lines read as capabilities.
    if (features.length < 24) {
      const bullets = text.match(/^\s*[-*]\s+(.{8,120})$/gm) || [];
      for (const b of bullets.slice(0, 3)) features.push(b.replace(/^\s*[-*]\s+/, '').trim());
    }
    // Limitation cues — require a cue word with a colon/dash separator (line-start
    // or after a sentence boundary) so mid-sentence matches stay out.
    const limLines = text.match(/(?:^|\n\s*(?:[-*]\s*)?)((?:warning|caution|limitation|caveat|known issue)\s*[:\-–]\s*.{10,180})/gi) || [];
    for (const l of limLines.slice(0, 2)) {
      const body = l.replace(/^.*?[:\-–]\s*/, '').trim();
      if (body) limitations.push(truncate(body, 180));
    }
    const notSupported = text.match(/(?:is not supported|are not supported|not yet supported|coming soon)\b[.:!]?(\s*.{0,160})?/gi) || [];
    for (const l of notSupported.slice(0, 2)) limitations.push(truncate(l.trim(), 180));
  }

  if (!summaryBody && chunks.length) {
    summaryBody = cleanText(chunks[0].text).slice(0, 500);
  }

  const summaryParts = [
    app.description ? truncate(app.description, 300) : '',
    summaryBody ? truncate(summaryBody, 420) : '',
  ].filter(Boolean);

  const featureList = dedupe(features, 14);
  const profile = {
    summary: summaryParts.join(' — ') || `${app.name} is an application indexed by Mascot.`,
    purpose: summaryParts[0] || '',
    features: featureList,
    audience: '',
    limitations: dedupe(limitations, 6),
    faqs: dedupeFaqs(faqs, 6),
    tone: 'friendly, concise and helpful',
    suggestions: [],
    confidence: 'heuristic',
    engineNotes: 'Built with the offline extractive engine. Configure an LLM provider and re-run analysis for a richer profile.',
  };

  // Suggested starter questions.
  const suggestions = featureList.slice(0, 4).map((f) => `What is ${f.replace(/[.?!]+$/, '')}?`);
  if (suggestions.length < 3) suggestions.push('What does this app do?', 'How do I get started?');
  profile.suggestions = suggestions.slice(0, 4);
  return profile;
}

function mergeReaInsights(profile, insights) {
  if (!insights) return;
  const extras = [];
  if (Array.isArray(insights.stack) && insights.stack.length) {
    extras.push(`Detected stack: ${insights.stack.slice(0, 8).join(', ')}`);
  }
  if (Array.isArray(insights.entryPoints) && insights.entryPoints.length) {
    extras.push(`Entry points: ${insights.entryPoints.slice(0, 5).join('; ')}`);
  }
  if (Array.isArray(insights.features) && insights.features.length) {
    profile.features = dedupe([...profile.features, ...insights.features.slice(0, 6)], 16);
  }
  if (extras.length) {
    profile.engineNotes = [profile.engineNotes, ...extras].filter(Boolean).join(' · ');
  }
}

/**
 * Run full analysis for an app.
 * @param {object} job created via createJob(store-less tracker)
 * @returns {object} the saved profile
 */
export async function analyzeApp(store, app, job) {
  try {
    const sources = store.getSources(app.id).filter((s) => s.status === 'ready');
    let chunks = store.getChunks(app.id);
    if (!chunks.length) {
      failJob(job, 'No knowledge indexed yet — add sources first.');
      recordJob(store, app, job);
      throw Object.assign(new Error('No knowledge indexed yet — add sources first.'), { code: 'no_knowledge' });
    }
    if (chunks.length > 600) {
      // Sample evenly to bound analysis cost.
      const step = chunks.length / 600;
      chunks = Array.from({ length: 600 }, (_, i) => chunks[Math.floor(i * step)]);
    }

    jobStep(job, 'starting', `${sources.length} ready sources · ${chunks.length} chunks in scope`, 5);
    const llm = getLlm(app.settings?.model || {});

    let profile;
    let engine = 'heuristic';
    if (llm.configured && llm.provider !== 'mock') {
      try {
        profile = await analyzeWithLlm(store, app, chunks, llm, job);
        engine = 'llm';
      } catch (err) {
        console.warn(`[analyzer] LLM analysis failed for ${app.id}: ${err.message}`);
        jobStep(job, 'llm engine failed; using extractive fallback', err.message, 75);
      }
    } else if (llm.provider === 'mock') {
      jobStep(job, 'mock provider: using extractive engine', '', 40);
    }
    if (!profile) {
      profile = analyzeHeuristically(store, app, chunks, sources);
    }

    // Fold in REA insights if present.
    const prevProfile = store.getProfile(app.id);
    if (prevProfile?.reaInsights) {
      profile.reaInsights = prevProfile.reaInsights;
      mergeReaInsights(profile, prevProfile.reaInsights);
    }

    // Suggestions fallback.
    if (!Array.isArray(profile.suggestions) || !profile.suggestions.length) {
      profile.suggestions = (profile.features || []).slice(0, 3).map((f) => `How does ${truncate(f, 60)} work?`);
      profile.suggestions.push('What is this app for?');
    }

    profile.lastAnalyzedAt = nowIso();
    profile.engine = engine;
    profile.sourceCount = sources.length;
    profile.chunkCount = chunks.length;
    profile.appName = app.name;

    store.saveProfile(app.id, profile);
    app.stats.lastAnalyzedAt = profile.lastAnalyzedAt;
    store.saveApp(app);

    finishJob(job, {
      engine,
      features: profile.features?.length || 0,
      faqs: profile.faqs?.length || 0,
      summary: profile.summary,
    });
    recordJob(store, app, job);
    return profile;
  } catch (err) {
    if (job.status === 'running') {
      failJob(job, err);
      recordJob(store, app, job);
    }
    throw err;
  }
}
