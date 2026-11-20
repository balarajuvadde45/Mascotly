// The mascot's brain: retrieval-augmented chat with an optional agentic loop.
// Protocol helpers live in agent-protocol.js.
import { searchApp } from '../knowledge/service.js';
import { buildSystemPrompt } from './prompt.js';
import { parseProtocol, findProtocolStart, STREAM_TAIL_GUARD } from './agent-protocol.js';
import { getLlm } from '../providers/llm.js';
import { config } from '../config.js';
import { truncate } from '../util.js';
import { makeSnippet } from '../knowledge/retriever.js';
import { tokenize } from '../knowledge/tokenize.js';

const MAX_ROUNDS = 2; // extra search rounds after the first answer

function allowedActions(app) {
  const list = Array.isArray(app.mascot?.actions) ? app.mascot.actions.map((a) => a.name) : [];
  return new Set([...list, 'escalate']);
}

function buildCitations(results, queryTokens, offset = 0) {
  return results.map((r, i) => ({
    n: offset + i + 1,
    chunkId: r.chunk.id,
    sourceId: r.chunk.sourceId,
    label: r.chunk.meta?.label || r.chunk.meta?.title || r.chunk.headingPath || 'knowledge',
    url: r.chunk.meta?.url || '',
    heading: r.chunk.headingPath || r.chunk.heading || '',
    snippet: makeSnippet(r.chunk.text, queryTokens, 200),
    score: Number((r.score ?? 0).toFixed(4)),
  }));
}

function offlineAnswer(app, message, citations, { llmConfigured, profile }) {
  const lines = [];
  // "What is <app>" style questions lead with the analyzer's summary when available.
  const lower = message.toLowerCase();
  const asksAboutApp = profile?.summary && lower.includes(String(app.name || '').toLowerCase().split(' ')[0]);
  if (asksAboutApp) {
    lines.push(truncate(profile.summary, 420));
    lines.push('');
  }
  if (!citations.length) {
    lines.push(
      `I don't have any indexed knowledge about **${app.name}** yet, so I can't answer that reliably.`,
      '',
      'The app owner can fix this quickly in the Mascot dashboard:',
      '- Add sources (docs URL, GitHub repo, files, reviews)',
      '- Re-run the analyzer',
    );
  } else {
    lines.push("Here's what I found in the app knowledge:");
    lines.push('');
    for (const c of citations.slice(0, 3)) lines.push(`- ${c.snippet} [${c.n}]`);
    lines.push('');
    lines.push(`Sources: ${[...new Set(citations.slice(0, 3).map((c) => c.label))].join(', ')}`);
  }
  if (!llmConfigured) {
    lines.push('');
    lines.push('_Running on the offline fallback brain — no LLM provider is configured. The app owner can add one in settings for full conversational answers._');
  }
  return lines.join('\n');
}

async function* yieldText(text, chunkSize = 48) {
  for (let i = 0; i < text.length; i += chunkSize) {
    yield text.slice(i, i + chunkSize);
  }
}

/**
 * One LLM round with protocol-safe streaming.
 * Yields {type:'delta', text} events; returns { raw, error }.
 */
async function* streamRound(llm, messages, opts) {
  let raw = '';
  let emitted = 0;
  let hold = -1;
  let gotAny = false;
  try {
    for await (const ev of llm.stream(messages, opts)) {
      gotAny = true;
      raw += ev.delta || '';
      if (hold === -1) {
        const found = findProtocolStart(raw);
        if (found) {
          hold = found.index;
          if (hold > emitted) {
            yield { type: 'delta', text: raw.slice(emitted, hold) };
            emitted = hold;
          }
        } else {
          const safeEnd = Math.max(emitted, raw.length - STREAM_TAIL_GUARD);
          if (safeEnd > emitted) {
            yield { type: 'delta', text: raw.slice(emitted, safeEnd) };
            emitted = safeEnd;
          }
        }
      }
    }
    if (hold === -1 && raw.length > emitted) {
      yield { type: 'delta', text: raw.slice(emitted) };
    }
    return { raw, error: false };
  } catch (err) {
    if (!gotAny) {
      // Streaming unsupported/failed before any output → plain completion.
      try {
        raw = (await llm.chat(messages, opts)).text || '';
        yield { type: 'delta', text: raw };
        return { raw, error: false };
      } catch {
        return { raw: '', error: true };
      }
    }
    // Partial output then failure: flush what we safely can.
    if (hold === -1 && raw.length > emitted) {
      yield { type: 'delta', text: raw.slice(emitted) };
    }
    return { raw, error: true };
  }
}

function formatExtraKnowledge(results, offset) {
  const blocks = results.map((r, i) => {
    const meta = r.chunk.meta || {};
    const srcBits = [meta.label || meta.title || 'knowledge'];
    if (meta.url) srcBits.push(meta.url);
    const head = r.chunk.headingPath ? ` › ${truncate(r.chunk.headingPath, 100)}` : '';
    return `[${offset + i + 1}] (${truncate(srcBits.join(' · '), 140).replaceAll(')', '')})${head}\n${truncate(r.chunk.text, 1600)}`;
  });
  return blocks.join('\n\n');
}

/** Execute an app-owned HTTP tool plugin. Bounded, never throws. */
async function callAppTool(app, toolRequest) {
  const tools = Array.isArray(app.tools) ? app.tools : [];
  const tool = tools.find((t) => t.name === toolRequest.tool && t.enabled !== false);
  if (!tool) return { error: `Unknown tool: ${toolRequest.tool}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const method = tool.method || 'POST';
    const opts = {
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'MascotlyTools/0.1',
        ...(tool.headers || {}),
      },
      signal: controller.signal,
      redirect: 'error',
    };
    if (method === 'POST') {
      opts.body = JSON.stringify({ args: toolRequest.args || {}, context: {} });
    }
    const res = await fetch(tool.url, opts);
    const body = (await res.text()).slice(0, 32_000);
    return { status: res.status, ok: res.ok, body };
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat with the mascot.
 * @param {object} store
 * @param {object} app
 * @param {object} params { message, history, page }
 * @returns {AsyncGenerator<{type:string, ...}>} events:
 *   status {detail} | delta {text} | action {name,args} | done {answer, citations, action, escalated, usage}
 */
export async function* chatStream(store, app, params = {}) {
  const startedAt = Date.now();
  const message = String(params.message || '').trim();
  const history = Array.isArray(params.history) ? params.history.slice(-config.llm.maxHistoryMessages) : [];
  const page = params.page && typeof params.page === 'object' ? params.page : null;

  if (!message) {
    yield { type: 'error', error: 'empty_message', message: 'Message is empty' };
    return;
  }

  const llm = getLlm(app.settings?.model || {});
  const topK = config.retrieval.topK;

  // 1) Retrieve knowledge for the question.
  yield { type: 'status', detail: 'thinking' };
  let contexts = []; // raw retrieval results (full chunk text for the prompt)
  let citations = [];
  try {
    contexts = await searchApp(store, app, message, topK);
    citations = buildCitations(contexts, tokenize(message));
  } catch (err) {
    console.warn(`[brain] retrieval failed for ${app.id}: ${err.message}`);
  }

  // 2) Generate the answer (with up to MAX_ROUNDS extra search rounds).
  let visibleText = '';
  let usedAction = null;
  let escalated = false;
  let allCitations = citations;
  let rounds = 0;
  let llmError = false;

  if (llm.configured) {
    // Full chunk text goes into the prompt (buildSystemPrompt caps each block);
    // citations carry the short snippets used for display.
    const sys = buildSystemPrompt(app, store.getProfile(app.id), contexts, { page });

    const messages = [
      { role: 'system', content: sys },
      ...history
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
        .map((h) => ({ role: h.role, content: truncate(h.content, 4000) })),
      { role: 'user', content: truncate(message, 4000) },
    ];

    let finished = false;
    // Max LLM calls = MAX_ROUNDS + 1: up to MAX_ROUNDS knowledge-search rounds,
    // then a forced final answer (a tool request on the last round is stripped).
    while (!finished && rounds <= MAX_ROUNDS + 1) {
      rounds += 1;
      const { raw, error } = yield* streamRound(llm, messages, {
        temperature: llm.temperature,
        maxTokens: llm.maxTokens,
      });
      llmError = llmError || error;

      const { visible, toolRequest, action } = parseProtocol(raw);

      if (toolRequest && rounds <= MAX_ROUNDS) {
        yield { type: 'status', detail: toolRequest.name === 'call_tool' ? 'calling_tool' : 'searching_knowledge' };

        if (toolRequest.name === 'call_tool' && toolRequest.tool) {
          // ── HTTP tool plugin execution ──
          const toolResult = await callAppTool(app, toolRequest);
          messages.push({ role: 'assistant', content: truncate(raw, 2000) });
          messages.push({
            role: 'user',
            content: [
              `(Tool "${toolRequest.tool}" result)`,
              truncate(JSON.stringify(toolResult), 6000),
              '',
              'Now give your final answer to the user\'s original question using the tool result. Do not request another search or tool call.',
            ].join('\n'),
          });
          continue;
        }

        // ── knowledge search round ──
        let extraResults = [];
        try {
          extraResults = await searchApp(store, app, toolRequest.query || message, topK);
        } catch { /* ignore */ }
        const offset = allCitations.length;
        const newCitations = buildCitations(extraResults, tokenize(toolRequest.query || message), offset);
        allCitations = [...allCitations, ...newCitations];
        messages.push({ role: 'assistant', content: truncate(raw, 2000) });
        messages.push({
          role: 'user',
          content: [
            `(Extra knowledge retrieved for "${truncate(toolRequest.query, 200)}")`,
            newCitations.length ? formatExtraKnowledge(extraResults, offset) : '(No additional knowledge found.)',
            '',
            `Now give your final answer to the user's original question. Cite sources as [n] using the numbering above (${newCitations.map((c) => `[${c.n}]`).join(' ') || 'none available'}). Do not request another search.`,
          ].join('\n'),
        });
        continue;
      }

      if (action) {
        const allowed = allowedActions(app);
        if (allowed.has(action.name)) {
          usedAction = action;
          if (action.name === 'escalate') escalated = true;
        }
      }
      visibleText = visible;
      finished = true;
    }
    if (!visibleText.trim()) {
      visibleText = offlineAnswer(app, message, allCitations, { llmConfigured: true, profile: store.getProfile(app.id) });
      if (llmError) {
        visibleText += '\n\n_(The AI provider had trouble responding; showing knowledge excerpts instead.)_';
      }
    }
  } else {
    visibleText = offlineAnswer(app, message, citations, { llmConfigured: false, profile: store.getProfile(app.id) });
    for await (const piece of yieldText(visibleText)) yield { type: 'delta', text: piece };
  }

  // 3) Escalation heuristics.
  if (!escalated) {
    const keywords = app.settings?.escalationKeywords || [];
    const lower = message.toLowerCase();
    escalated = keywords.some((k) => k && lower.includes(String(k).toLowerCase()));
  }

  // 4) Emit remaining events.
  if (usedAction) yield { type: 'action', action: usedAction };
  yield {
    type: 'done',
    answer: visibleText,
    citations: allCitations,
    action: usedAction,
    escalated,
    usage: {
      provider: llm.provider,
      model: llm.model,
      rounds,
      latencyMs: Date.now() - startedAt,
      citations: allCitations.length,
    },
  };
}

/** Convenience non-streaming wrapper. Returns the `done` event payload. */
export async function chat(store, app, params = {}) {
  let done = null;
  for await (const ev of chatStream(store, app, params)) {
    if (ev.type === 'done') done = ev;
    if (ev.type === 'error') return { answer: '', citations: [], error: ev.error, message: ev.message };
  }
  return done || { answer: '', citations: [], error: 'no_answer' };
}
