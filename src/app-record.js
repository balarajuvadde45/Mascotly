// Shared app-record construction — the single source of truth for the shape of
// an app across every storage backend (file / KV / Postgres).
import { newId, nowIso, slugify, secretKey } from './util.js';

export function buildAppRecord({ name, description = '', mascot = {}, settings = {} }, ids = {}) {
  const id = ids.id || newId('app');
  return {
    id,
    slug: ids.slug || slugify(name),
    name,
    description,
    createdAt: ids.createdAt || nowIso(),
    updatedAt: ids.updatedAt || nowIso(),
    publicKey: ids.publicKey || secretKey(16),
    secretKey: ids.secretKey || secretKey(24),
    mascot: {
      name: mascot.name || 'Mottie',
      emoji: mascot.emoji || '🤖',
      color: mascot.color || '#6c5ce7',
      greeting: mascot.greeting || `Hi! I'm ${mascot.name || 'Mottie'} — ask me anything about this app.`,
      tagline: mascot.tagline || 'AI assistant',
      personality: mascot.personality || 'friendly, concise and helpful. You keep answers short and use markdown lists when helpful.',
      welcome: mascot.welcome ?? true,
      suggestions: Array.isArray(mascot.suggestions) ? mascot.suggestions.slice(0, 6) : [],
      actions: Array.isArray(mascot.actions) ? mascot.actions.slice(0, 12) : [],
      avatarUrl: mascot.avatarUrl || '',
      position: mascot.position === 'bottom-left' ? 'bottom-left' : 'bottom-right',
      telemetryOff: !!mascot.telemetryOff,
    },
    settings: {
      rateLimitPerMin: Number.isFinite(settings.rateLimitPerMin) ? settings.rateLimitPerMin : 20,
      allowedOrigins: Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : [],
      escalationKeywords: Array.isArray(settings.escalationKeywords) && settings.escalationKeywords.length
        ? settings.escalationKeywords
        : ['human', 'real person', 'support ticket', 'complain', 'refund', 'cancel account'],
      autoAnalyze: settings.autoAnalyze !== false,
      systemPromptExtra: String(settings.systemPromptExtra || ''),
      ...(settings.model && typeof settings.model === 'object' ? {
        model: {
          provider: String(settings.model.provider || 'auto').slice(0, 40),
          baseUrl: String(settings.model.baseUrl || '').slice(0, 300),
          model: String(settings.model.model || '').slice(0, 120),
          apiKey: String(settings.model.apiKey || '').slice(0, 300),
        },
      } : {}),
      ...(settings.embeddings && typeof settings.embeddings === 'object' ? {
        embeddings: {
          provider: String(settings.embeddings.provider || 'none').slice(0, 40),
          baseUrl: String(settings.embeddings.baseUrl || '').slice(0, 300),
          model: String(settings.embeddings.model || '').slice(0, 120),
          apiKey: String(settings.embeddings.apiKey || '').slice(0, 300),
        },
      } : {}),
    },
    skills: [],   // SKILL.md-compatible capability packs (agentskills.io format)
    tools: [],    // HTTP tool plugins callable by the mascot mid-chat
    hooks: [],    // signed lifecycle webhooks (message/escalation/feedback)
    stats: { messages: 0, sessions: 0, chunks: 0, ingestedChars: 0, lastChatAt: null, lastAnalyzedAt: null },
    jobs: [],
  };
}
