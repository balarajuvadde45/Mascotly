// Model router — routes each chat turn to the right model tier.
//
// Tiers (user-facing names, mapped to real models via env):
//   sol   — fast + cheap: greetings, simple lookups, short clarifications
//   lune  — balanced default: normal product questions (fallback for everything)
//   astra — deep reasoning: comparisons, code, multi-part analysis
//
// Mapping (all optional; anything unset inherits the server/app default model):
//   MASCOT_MODEL_SOL=<model>            MASCOT_MODEL_SOL_PROVIDER=...  BASE_URL/API_KEY optional
//   MASCOT_MODEL_LUNE=<model>           ...
//   MASCOT_MODEL_ASTRA=<model>          ...
// Claude presets (example):
//   MASCOT_MODEL_SOL=claude-3-5-haiku-latest        MASCOT_MODEL_SOL_PROVIDER=anthropic
//   MASCOT_MODEL_LUNE=claude-3-5-sonnet-latest      MASCOT_MODEL_LUNE_PROVIDER=anthropic
//   MASCOT_MODEL_ASTRA=claude-opus-4-1              MASCOT_MODEL_ASTRA_PROVIDER=anthropic
//
// Routing decision: heuristic complexity score (fast + deterministic); with
// MASCOT_ROUTER_LLM=1 and a configured model, an LLM classification refines it.
import { config } from './config.js';
import { createLlm } from './providers/llm.js';
import { ROUTER_CLASSIFY, fill } from './prompts.js';

const TIERS = ['sol', 'lune', 'astra'];

function tierSettings(tier) {
  const t = String(tier || '').toLowerCase();
  const up = t.toUpperCase();
  const model = process.env[`MASCOT_MODEL_${up}`] || '';
  if (!model) return null; // inherit the app/server default
  return {
    provider: (process.env[`MASCOT_MODEL_${up}_PROVIDER`] || '').toLowerCase() || undefined,
    model,
    baseUrl: process.env[`MASCOT_MODEL_${up}_BASE_URL`] || undefined,
    apiKey: process.env[`MASCOT_MODEL_${up}_API_KEY`] || undefined,
    maxTokens: tier === 'sol' ? 700 : tier === 'astra' ? 2000 : undefined,
  };
}

/** Heuristic complexity score → tier. Deterministic; tuned for product chats. */
export function classifyHeuristic(message) {
  const m = String(message || '');
  const len = m.trim().length;
  const q = m.toLowerCase();

  let score = 0;
  if (len > 220) score += 2;
  else if (len > 90) score += 1;
  const deepSignals = [
    /\b(compare|versus|vs\.?|difference|pros and cons|trade-?offs?)\b/,
    /\b(why|explain|how does .* work|architecture|design|analyze|analysis)\b/,
    /\b(code|snippet|function|implement|example script|regex|sql|migration)\b/,
    /\b(step by step|steps|migration|debug|error|stack trace|troubleshoot)\b/,
    /\b(best practice|recommend|which should|strategy)\b/,
    /\?\s*.*\?/s,                                   // multi-part questions
    /\b(and also|additionally|then also|plus)\b/,
  ];
  for (const re of deepSignals) if (re.test(q)) score += 1;

  const fastSignals = [
    /^(hi|hey|hello|yo|sup|thanks|thank you|ok|okay|cool|nice)\b/,
    /\b(where|what is the link|find the button|which menu)\b/,
    /\b(yes|no|confirm)\b/,
  ];
  for (const re of fastSignals) if (re.test(q)) score -= 2;

  if (score <= -1) return 'sol';
  if (score >= 3) return 'astra';
  return 'lune';
}

/**
 * Optional LLM refinement using the cheapest configured tier.
 * Falls back to the heuristic on any error. Result cached per message hash.
 */
const classifyCache = new Map();
async function classifyWithLlm(message, app) {
  const key = String(message).slice(0, 200);
  if (classifyCache.has(key)) return classifyCache.get(key);
  try {
    const llm = createLlm(tierSettings('sol') || resolveBase(app));
    if (!llm.configured) throw new Error('no llm');
    const res = await llm.chat(
      [{ role: 'user', content: fill(ROUTER_CLASSIFY, { message: String(message).slice(0, 600) }) }],
      { temperature: 0, maxTokens: 12 }
    );
    const tier = String(res.text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    const out = TIERS.includes(tier) ? tier : null;
    if (out) {
      if (classifyCache.size > 500) classifyCache.clear();
      classifyCache.set(key, out);
    }
    return out;
  } catch {
    return null;
  }
}

function resolveBase(app) {
  // The app/server default model — the "lune" fallback when tiers aren't mapped.
  return {
    ...(app?.settings?.model || {}),
    provider: app?.settings?.model?.provider || config.llm.provider,
    baseUrl: app?.settings?.model?.baseUrl || config.llm.baseUrl,
    model: app?.settings?.model?.model || config.llm.model,
    apiKey: app?.settings?.model?.apiKey || config.llm.apiKey,
    temperature: app?.settings?.model?.temperature ?? config.llm.temperature,
    maxTokens: app?.settings?.model?.maxTokens ?? config.llm.maxTokens,
  };
}

/**
 * Route a chat turn.
 * @returns {Promise<{tier: string, settings: object|null}>}
 *   settings = LLM settings override for createLlm(); null → use default client.
 */
export async function routeFor(message, app) {
  let tier = classifyHeuristic(message);
  if (process.env.MASCOT_ROUTER_LLM === '1' || config.router?.llm) {
    const refined = await classifyWithLlm(message, app);
    if (refined) tier = refined;
  }
  const override = tierSettings(tier);
  return { tier, settings: override };
}

/** Build the LLM client for a routed turn (falls back to the default client). */
export function llmForRoute(app, route) {
  if (route?.settings) {
    const base = resolveBase(app);
    return createLlm({
      ...base,
      ...Object.fromEntries(Object.entries(route.settings).filter(([, v]) => v !== undefined)),
      temperature: app?.settings?.model?.temperature ?? config.llm.temperature,
    });
  }
  return createLlm(resolveBase(app));
}

/** Context budget per tier (chars of retrieved knowledge allowed into the prompt). */
export function contextBudget(tier) {
  if (tier === 'sol') return 3500;
  if (tier === 'astra') return config.retrieval.contextChars;
  return Math.round(config.retrieval.contextChars * 0.7);
}
