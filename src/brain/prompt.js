// Brain-facing adapter over the central prompt registry (src/prompts.js).
// All actual prompt text lives there — edit src/prompts.js to change behavior.
import { buildChatSystemPrompt, GUARDRAILS } from '../prompts.js';

export { GUARDRAILS };

/**
 * Build the mascot's chat system prompt.
 * @param {object} app
 * @param {object|null} profile — analyzer profile
 * @param {Array<{chunk}>} contexts — retrieval results
 * @param {object} opts { page, memory }
 */
export function buildSystemPrompt(app, profile, contexts, opts = {}) {
  return buildChatSystemPrompt({
    app,
    profile,
    contexts,
    memory: opts.memory || [],
    page: opts.page || null,
  });
}
