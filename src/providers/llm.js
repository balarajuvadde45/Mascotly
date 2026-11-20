// LLM provider abstraction. One interface, many backends:
//   openai-compatible (OpenAI / Groq / Together / vLLM / LM Studio / Ollama's /v1)
//   anthropic          (Claude, /v1/messages)
//   mock               (deterministic extractive answers — tests & zero-config demo)
//
// The brain never talks to a provider directly; it goes through createLlm()/getLlm().
import { resolveLlmSettings } from '../config.js';
import { truncate } from '../util.js';

export class LlmUnavailableError extends Error {
  constructor(message = 'No LLM provider is configured') {
    super(message);
    this.name = 'LlmUnavailableError';
    this.code = 'llm_unavailable';
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse an SSE byte stream into `data:` payload strings. */
async function* sseDataLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
    }
  }
}

class OpenAiCompatibleLlm {
  constructor(s) {
    this.provider = s.provider;
    this.model = s.model || 'gpt-4o-mini';
    this.baseUrl = (s.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = s.apiKey || '';
    this.timeoutMs = s.timeoutMs || 60000;
    this.configured = true;
  }

  headers() {
    const h = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async chat(messages, opts = {}) {
    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 1200,
        stream: false,
      }),
    }, this.timeoutMs);
    if (!res.ok) {
      const detail = truncate(await res.text().catch(() => ''), 300);
      throw new Error(`LLM request failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    return { text: String(text), finishReason: data?.choices?.[0]?.finish_reason || null, usage: data?.usage || null };
  }

  async *stream(messages, opts = {}) {
    const res = await fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.4,
        max_tokens: opts.maxTokens ?? 1200,
        stream: true,
      }),
    }, this.timeoutMs);
    if (!res.ok || !res.body) {
      const detail = res.body ? truncate(await res.text().catch(() => ''), 300) : 'no body';
      throw new Error(`LLM stream failed (${res.status}): ${detail}`);
    }
    for await (const payload of sseDataLines(res.body)) {
      if (payload === '[DONE]') return;
      const parsed = JSON.parse(payload);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (delta) yield { delta: String(delta) };
    }
  }
}

class AnthropicLlm {
  constructor(s) {
    this.provider = 'anthropic';
    this.model = s.model || 'claude-3-5-haiku-latest';
    this.baseUrl = (s.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
    this.apiKey = s.apiKey || '';
    this.timeoutMs = s.timeoutMs || 60000;
    this.configured = true;
  }

  /** Anthropic wants a top-level system string and strictly alternating user/assistant turns. */
  static toAnthropicMessages(messages) {
    const systemParts = [];
    const turns = [];
    for (const m of messages) {
      if (m.role === 'system') { systemParts.push(m.content); continue; }
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.content += `\n\n${m.content}`;
      else turns.push({ role, content: m.content });
    }
    if (!turns.length || turns[0].role !== 'user') turns.unshift({ role: 'user', content: '(begin)' });
    return { system: systemParts.join('\n\n'), messages: turns };
  }

  async chat(messages, opts = {}) {
    const { system, messages: turns } = AnthropicLlm.toAnthropicMessages(messages);
    const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1200,
        temperature: opts.temperature ?? 0.4,
        ...(system ? { system } : {}),
        messages: turns,
        stream: false,
      }),
    }, this.timeoutMs);
    if (!res.ok) {
      const detail = truncate(await res.text().catch(() => ''), 300);
      throw new Error(`LLM request failed (${res.status}): ${detail}`);
    }
    const data = await res.json();
    const text = (Array.isArray(data?.content) ? data.content : [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, finishReason: data?.stop_reason || null, usage: data?.usage || null };
  }

  async *stream(messages, opts = {}) {
    const { system, messages: turns } = AnthropicLlm.toAnthropicMessages(messages);
    const res = await fetchWithTimeout(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 1200,
        temperature: opts.temperature ?? 0.4,
        ...(system ? { system } : {}),
        messages: turns,
        stream: true,
      }),
    }, this.timeoutMs);
    if (!res.ok || !res.body) {
      const detail = res.body ? truncate(await res.text().catch(() => ''), 300) : 'no body';
      throw new Error(`LLM stream failed (${res.status}): ${detail}`);
    }
    for await (const payload of sseDataLines(res.body)) {
      const parsed = JSON.parse(payload);
      if (parsed?.type === 'content_block_delta' && parsed?.delta?.text) {
        yield { delta: String(parsed.delta.text) };
      }
      if (parsed?.type === 'message_stop') return;
    }
  }
}

/**
 * Deterministic offline "brain": composes an answer from the knowledge blocks in
 * the system prompt so the widget, analyzer pipeline and tests work with zero API keys.
 */
export class MockLlm {
  constructor(s) {
    this.provider = 'mock';
    this.model = 'mock-1';
    this.configured = true;
  }

  extractKnowledge(systemText) {
    // Blocks are formatted as "[n] (source) › optional heading\ntext…" by prompt.js.
    // Stateful line parse: a block runs until the next "[n] (" line.
    const items = [];
    const blockStart = /^\[(\d+)\][ \t]+\(([^)]*)\)[ \t]*?(.*)$/;
    let current = null;
    for (const line of String(systemText).split('\n')) {
      const m = line.match(blockStart);
      if (m) {
        if (current) items.push(current);
        current = { n: m[1], source: m[2], text: (m[3] || '').trim() };
      } else if (current) {
        current.text = (current.text ? `${current.text}\n` : '') + line;
      }
    }
    if (current) items.push(current);
    // Drop the leading breadcrumb heading (" › Section › Sub") from the first line.
    for (const it of items) {
      it.text = it.text.replace(/^[ \t]*›[^\n]*\n?/, '').replace(/\s+$/, '').trim();
    }
    return items.filter((it) => it.text);
  }

  async chat(messages, opts = {}) {
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const knowledge = this.extractKnowledge(system);
    const text = mockAnswer(lastUser, knowledge, system);
    // Simulate token-ish streaming for downstream consistency.
    if (opts.streamRequested) {
      /* no-op: stream() below is used instead */
    }
    return { text, finishReason: 'stop', usage: null };
  }

  async *stream(messages, opts = {}) {
    const { text } = await this.chat(messages, opts);
    const words = text.split(/(\s+)/);
    let buf = '';
    for (const w of words) {
      buf += w;
      if (buf.length >= 24) {
        yield { delta: buf };
        buf = '';
      }
    }
    if (buf) yield { delta: buf };
  }
}

function mockAnswer(userMessage, knowledge, systemText) {
  const q = String(userMessage || '').toLowerCase();
  const bullets = knowledge.slice(0, 3).map((k) => `- ${truncate(k.text.replace(/\s+/g, ' '), 180)}`);
  const sources = [...new Set(knowledge.slice(0, 3).map((k) => k.source).filter(Boolean))];

  if (/^(hi|hello|hey|yo)\b/.test(q)) {
    return "Hello! I'm the app's built-in mascot, running on Mascot's offline mock brain. Ask me anything about this application — when a real LLM provider is configured, I get much smarter.";
  }
  if (/what can you do|help me|who are you|about you/.test(q)) {
    return [
      "I'm the mascot embedded in this app. I answer questions using the app's indexed knowledge (docs, reviews, and any reverse-engineered insights).",
      '',
      'A few things you can try:',
      '- Ask what a specific feature does',
      '- Ask how to get started',
      '- Ask about known limitations',
      '',
      '_Note: I am currently running on the deterministic mock brain. Configure an LLM provider (OpenAI-compatible, Anthropic, Groq or Ollama) for full conversational answers._',
    ].join('\n');
  }
  if (!bullets.length) {
    return [
      "I don't have indexed knowledge about that yet. The app owner can add sources in the Mascot dashboard (docs URLs, GitHub repos, files, reviews) and re-run analysis.",
      '',
      '_Mock brain — no LLM provider configured._',
    ].join('\n');
  }
  const lines = [
    `Here's what I know about that${sources.length ? ` (from ${sources.join(', ')})` : ''}:`,
    '',
    ...bullets,
    '',
    '_Answered with the offline mock brain — configure an LLM provider for richer, conversational replies._',
  ];
  return lines.join('\n');
}

class UnconfiguredLlm {
  constructor() {
    this.provider = 'none';
    this.model = null;
    this.configured = false;
  }
  async chat() { throw new LlmUnavailableError(); }
  async *stream() { throw new LlmUnavailableError(); }
}

export function createLlm(settings) {
  switch (settings.provider) {
    case 'mock': return new MockLlm(settings);
    case 'anthropic': return new AnthropicLlm(settings);
    case 'openai':
    case 'groq':
    case 'ollama':
    case 'openai-compatible':
      return new OpenAiCompatibleLlm(settings);
    default: return new UnconfiguredLlm();
  }
}

/** Resolve settings (app-level override wins) and build a client. */
export function getLlm(appOverride) {
  return createLlm(resolveLlmSettings(appOverride || {}));
}
